import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { ClaimStateResult } from "@toon-protocol/client";

import {
  createProviderJobDeliveryPort,
  describeFactoryJobPaymentSetupError,
  type FactoryJobIncrementPaymentReceipt,
  JOB_DELIVERY_NEEDS_BTP_MESSAGE,
  type ProviderJobDeliveryPort,
} from "@/shared/api/toonJobDelivery";
import {
  buildToonClientOptions,
  SETTLEMENT_ASSET,
  SETTLEMENT_ASSET_SCALE,
  ToonPaidWriteError,
} from "@/shared/api/toonPaidWriteConfig";

// Re-exported so existing importers keep one home for the paid-write surface.
export type { FactoryJobIncrementPaymentReceipt } from "@/shared/api/toonJobDelivery";
export {
  ToonPaidWriteError,
  transportEndpointFields,
} from "@/shared/api/toonPaidWriteConfig";
export { buildToonClientOptions };

import { splitClaimStateWatermark } from "@/features/profile/lib/claimStateWatermark";
import {
  clearPersistedChannel,
  hasPersistedChannel,
  loadPersistedChannel,
  savePersistedChannel,
  type PersistedChannelContext,
} from "@/shared/api/toonChannelResumeStore";
import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";
import type { RelayEvent } from "@/shared/api/types";
import type {
  ChannelCloseState,
  RawPaymentChannelStatus,
} from "@/features/payments/lib/paymentsOverview";

/**
 * The paying half of the TOON transport.
 *
 * A write on TOON is an ILP packet carrying a payment-channel claim, so
 * publishing costs money and can fail for reasons a relay never has: no
 * channel, no collateral, no route price. All of that lives here, behind a
 * two-method surface (`ready`, `publish`), so `ToonEventTransport` stays a
 * shape adapter the way `RelayEventTransport` is.
 *
 * `@toon-protocol/client` is imported lazily. It pulls in viem and the whole
 * settlement stack, and the relay transport is the default — an app that never
 * switches to TOON should not pay for the chunk.
 */

/** What one paid write cost, once the packet came back. */
export type PaidWriteReceipt = {
  eventId: string;
  /** Base units of {@link PaidWriteReceipt.asset} spent on this packet. */
  amount: bigint;
  /** Decimals for `amount` — 6 for USDC. */
  assetScale: number;
  asset: string;
  destination: string;
};

export type PaidWriteListener = (receipt: PaidWriteReceipt) => void;

/**
 * What {@link ToonPaidWriter.getNetworkFlowStatus} reads for one channel —
 * deposit, cumulative-claimed, and credited, tagged with where the read came
 * from (`"claim-state"` when the connector verified it, `"local"` for this
 * client's own tracked watermark).
 */
export type RawNetworkFlowStatus = {
  channelId: string;
  depositTotalBaseUnits: bigint;
  cumulativeClaimedBaseUnits: bigint;
  /**
   * Earned credit netted into this SAME channel's claim watermark — never a
   * separate ledger (`@toon-protocol/client`'s "Earning" docs, toon-meta#262
   * decision 9). Always `0n` for `source: "local"`: this client's own
   * tracked watermark only knows what IT spent, not a credit the connector
   * applied — see {@link ToonPaidWriter.tryClaimState}.
   */
  creditedBaseUnits: bigint;
  source: "claim-state" | "local";
};

/**
 * The connector's session lease TTL, as last confirmed by a real write —
 * buzz#84's freshness invariant (`providerAvailability.ts`) reads this
 * rather than a hardcoded constant. `observedAtMs` is stamped fresh on
 * every successful write, not just the first: `ToonClient` caches the
 * greeting negotiation per peer, so a repeat write does not re-fetch the
 * TTL, but it still proves the SESSION (not just the cached negotiation)
 * was live at that moment — which is what the freshness window needs to
 * bound.
 */
export type SessionLease = {
  sessionLeaseTtlMs: number;
  observedAtMs: number;
};

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Render a receipt as the fee line a user is shown before/after paying. */
export function formatFee(receipt: PaidWriteReceipt): string {
  const divisor = 10 ** receipt.assetScale;
  const value = Number(receipt.amount) / divisor;
  // Sub-cent fees are the normal case, so fixed 2dp would render every write
  // as "0.00". Show enough places to make the amount legible.
  const text = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: receipt.assetScale,
  });
  return `${text} ${receipt.asset}`;
}

/**
 * A signed balance proof, as `ToonClient.signBalanceProof` returns it —
 * carried through to `publishEvent`'s `claim` option unmodified. Only the
 * fields this module reads itself (to keep the resume watermark current) are
 * named; the rest ride along opaquely.
 */
type BalanceProof = {
  channelId: string;
  nonce: number;
  transferredAmount: bigint;
};

/**
 * The shape of `ToonClient`'s private `channelManager` this module reaches
 * into to resume a channel — same reflection trick
 * `@toon-protocol/client-mcp`'s daemon (`client-runner.ts`) and
 * `@toon-protocol/rig` use for the identical problem: `ChannelManager` is a
 * TS-private field (not a real JS `#private`), so the cast is a runtime
 * no-op, but it is still reaching past the public API and breaks silently if
 * `ToonClient`'s internals move. `ensureChannelId` treats a missing/mismatched
 * shape as "cannot resume" rather than throwing.
 */
type ChannelManagerLike = {
  isTracking(channelId: string): boolean;
  trackChannel(
    channelId: string,
    context: PersistedChannelContext,
    initialNonce?: number,
    initialAmount?: bigint,
  ): void;
};

function channelManagerOf(client: PaidClient): ChannelManagerLike | undefined {
  const candidate = (client as unknown as { channelManager?: unknown })
    .channelManager;
  if (
    candidate &&
    typeof (candidate as ChannelManagerLike).isTracking === "function" &&
    typeof (candidate as ChannelManagerLike).trackChannel === "function"
  ) {
    return candidate as ChannelManagerLike;
  }
  return undefined;
}

/**
 * The `extra` bag of the connector's x402 greeting `accepts` entry, as
 * `ConnectorRouteTerms.extra` carries it (toon-client#509,
 * `@toon-protocol/client@0.28.0`). `session_lease_ttl_ms` is the one member
 * this module reads by name; everything else rides along unread.
 */
type ConnectorGreetingExtra = { session_lease_ttl_ms?: number };

/** The subset of `ToonClient` this module drives. */
type PaidClient = {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  getRoutePrice(destination: string): Promise<bigint | null>;
  /**
   * Open (or return the already-open) payment channel for `destination`.
   * Locks fresh on-chain collateral — `ensureChannelId` only calls this when
   * no resumable channel was found.
   */
  openChannel(destination?: string): Promise<string>;
  /** Sign a claim for `amount` against an already-tracked channel. */
  signBalanceProof(channelId: string, amount: bigint): Promise<BalanceProof>;
  publishEvent(
    event: RelayEvent,
    options?: {
      destination?: string;
      ilpAmount?: bigint;
      claim?: BalanceProof;
    },
  ): Promise<{
    success: boolean;
    eventId?: string;
    error?: string;
    code?: string;
    refusedBy?: string;
  }>;
  uploadBlob(params: {
    blobData: Uint8Array;
    contentType?: string;
    destination?: string;
    ilpAmount?: bigint;
  }): Promise<{
    success: boolean;
    txId?: string;
    eventId?: string;
    error?: string;
  }>;
  /**
   * Send a raw ILP packet carrying a sender-chosen execution condition
   * (toon-client#350) rather than the connector-minted one `publishEvent`
   * uses. This is what `payFactoryJobIncrement` rides: the condition is the
   * job's own hashlock (§4.2), not a route price.
   */
  sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    claim?: BalanceProof;
    executionCondition?: Uint8Array;
  }): Promise<{
    accepted: boolean;
    data?: string;
    code?: string;
    message?: string;
    fulfillment?: string;
  }>;
  /** Cumulative claimed amount for a tracked channel — spend, not collateral. */
  getChannelCumulativeAmount(channelId: string): bigint;
  /** On-chain deposit total (locked collateral) for a tracked channel. */
  getChannelDepositTotal(channelId: string): bigint;
  /** Where a tracked channel sits in the withdraw journey. */
  getChannelCloseState(channelId: string): ChannelCloseState;
  getSettleableAt(channelId: string): bigint | undefined;
  /**
   * Connector-verified deposit/cumulative-claimed for tracked channels
   * (toon-client#494, live since `@toon-protocol/client@0.26.0`) — the
   * runway source of truth (toon-meta#261 decision 5), correct even when
   * this client's own local watermark has drifted. Optional rather than
   * required only so `scriptedClient()` test doubles that omit it still
   * satisfy this interface — every real build supplies it; a real client
   * that ever didn't (or an unreachable connector) falls back to the
   * locally-tracked `getChannelDepositTotal`/`getChannelCumulativeAmount`,
   * see `getNetworkFlowStatus`.
   */
  getClaimState?(
    channelIds?: string[],
    opts?: { expiresInSeconds?: number },
  ): Promise<ClaimStateResult[]>;
  /**
   * The `ConnectorRouteTerms` from the most recent ordinary channel
   * bootstrap (toon-client#509, `@toon-protocol/client@0.28.0`) — populated
   * by `publishEvent`/`openChannel`/`adoptChannel` themselves, with no
   * separate probe. `undefined` until this session's first successful
   * write, and permanently `undefined` against a `PaidClient` build that
   * predates issue #509. Optional for the same reason `getClaimState` is:
   * a test double or an older client build may not implement it.
   */
  getLastConnectorRouteTerms?(): { extra?: ConnectorGreetingExtra } | undefined;
  /** Add collateral to an open channel. `amount` is the delta, base units. */
  depositToChannel(
    channelId: string,
    amount: string | bigint,
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }>;
  /** Begin the settlement grace period (first half of withdraw). */
  closeChannel(channelId: string): Promise<{
    channelId: string;
    txHash?: string;
    closedAt: string;
    settleableAt: string;
  }>;
  /** Release collateral once the grace period has elapsed (second half). */
  settleChannel(
    channelId: string,
  ): Promise<{ channelId: string; txHash?: string }>;
};

export type PaidClientFactory = (
  config: ToonTransportConfig,
  /**
   * Present exactly when the config runs a BTP session (`btpUrl !== null`) —
   * the factory registers `jobDelivery.handleJob` as the client's
   * `jobHandler`. Absent on one-shot ILP-over-HTTP, which has no wire the
   * key release could ride (`toonJobDelivery.ts`).
   */
  jobDelivery?: ProviderJobDeliveryPort,
) => Promise<PaidClient>;

const createToonClient: PaidClientFactory = async (config, jobDelivery) => {
  const [options, { ToonClient }] = await Promise.all([
    buildToonClientOptions(config, config.accountIndex, config.initialDeposit),
    import("@toon-protocol/client"),
  ]);
  if (jobDelivery) {
    // Serve-side registration (toon-client#494): a connector-originated job
    // PREPARE addressed to this client is answered by the delivery port,
    // which reveals the staged increment key as the ILP fulfillment. Only
    // meaningful with a BTP session — the caller (`ensureClient`) never
    // passes a port on the HTTP-only transport.
    options.jobHandler = jobDelivery.handleJob;
  }
  return new ToonClient(options as never) as unknown as PaidClient;
};

export class ToonPaidWriter {
  private config: ToonTransportConfig;
  private readonly factory: PaidClientFactory;
  private readonly listeners = new Set<PaidWriteListener>();
  private client: PaidClient | null = null;
  private starting: Promise<PaidClient> | null = null;
  private routePrice: bigint | null = null;
  private storeRoutePrice: bigint | null = null;
  private ephemeralRoutePrice: bigint | null = null;
  private ephemeralRouteChecked = false;
  private lastReceipt: PaidWriteReceipt | null = null;
  private channelId: string | null = null;
  private channelReady: Promise<string> | null = null;
  private sessionLease: SessionLease | null = null;
  private deliveryPort: ProviderJobDeliveryPort | null = null;

  constructor(
    config: ToonTransportConfig,
    factory: PaidClientFactory = createToonClient,
  ) {
    this.config = config;
    this.factory = factory;
  }

  /** Whether a write can go out now without a start/channel-open first. */
  isWritable(): boolean {
    return this.client !== null;
  }

  /**
   * Whether this transport can DELIVER a factory-job increment (buzz#135) —
   * true exactly when `btpUrl` is active, because key release rides the
   * provider's own BTP session. HTTP-only can still QUOTE — see
   * {@link JOB_DELIVERY_NEEDS_BTP_MESSAGE} for the full rationale.
   */
  supportsJobDelivery(): boolean {
    return this.config.btpUrl !== null;
  }

  /**
   * The provider-session delivery port, starting the client (and so
   * registering the port's `handleJob` as the client's `jobHandler`) if it
   * has not started yet. Throws on an HTTP-only transport — see
   * {@link supportsJobDelivery} — rather than hand back a port whose armed
   * increment no PREPARE could ever reach.
   */
  async getJobDeliveryPort(): Promise<ProviderJobDeliveryPort> {
    if (!this.supportsJobDelivery()) {
      throw new ToonPaidWriteError(JOB_DELIVERY_NEEDS_BTP_MESSAGE);
    }
    await this.ensureClient();
    const port = this.deliveryPort;
    if (!port) {
      // Unreachable short of a programming error (`ensureClient` constructs
      // the port whenever `supportsJobDelivery()` holds) — but a missing
      // port must read as an error, never as an increment silently offered
      // without a registered key-release.
      throw new ToonPaidWriteError(
        "The delivery port was not constructed with the client — increment delivery is unavailable.",
      );
    }
    return port;
  }

  /**
   * Supply (or replace) the payment mnemonic before the client has started.
   *
   * `config` is otherwise frozen at construction, but the onboarding wizard
   * generates this identity interactively — after the writer already exists,
   * since it is built from whatever `BUZZ_TOON_MNEMONIC` (or a previously
   * stored wizard identity) resolved to at app bootstrap, which may be
   * nothing at all on a fresh install. A no-op once a client has started or
   * is starting: a live client already committed to a signer, and switching
   * the identity out from under it would desync the channel it opened from
   * the one future writes would try to use.
   */
  setMnemonic(mnemonic: string): void {
    if (this.client !== null || this.starting !== null) return;
    this.config = { ...this.config, mnemonic };
  }

  /** The most recent paid write's cost, for status surfaces. */
  getLastReceipt(): PaidWriteReceipt | null {
    return this.lastReceipt;
  }

  /**
   * The connector's session lease TTL, last confirmed live by a successful
   * write — see {@link SessionLease}. `undefined` until this session's first
   * successful write, and permanently `undefined` against a connector
   * predating connector#722 (`extra` absent). Never a substituted default —
   * callers (`providerAvailability.ts`) must treat an unknown TTL as
   * "not yet knowable", not as a live-but-unmeasured window.
   */
  getSessionLease(): SessionLease | undefined {
    return this.sessionLease ?? undefined;
  }

  /**
   * Read the connector's session lease TTL off the client's most recent
   * greeting negotiation, if any, and stamp it with the current time. Called
   * after every successful write (see {@link SessionLease}'s doc for why a
   * repeat call still matters even when the negotiation itself is cached).
   */
  private captureSessionLease(client: PaidClient): void {
    const ttlMs =
      client.getLastConnectorRouteTerms?.()?.extra?.session_lease_ttl_ms;
    if (typeof ttlMs === "number") {
      this.sessionLease = {
        sessionLeaseTtlMs: ttlMs,
        observedAtMs: Date.now(),
      };
    }
  }

  /** Observe every paid write's cost. Returns an unsubscribe. */
  onPaidWrite(listener: PaidWriteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start the client, which bootstraps against the edge and opens (or resumes)
   * the payment channel. Idempotent, and a failed start is not cached — the
   * common causes (unfunded wallet, edge down) are transient.
   */
  async ready(): Promise<void> {
    await this.ensureClient();
  }

  /**
   * The flat per-packet price of the publish route, asked of the connector
   * that charges it. Quoted before the write so the fee can be shown rather
   * than inferred.
   */
  async quoteFee(): Promise<bigint> {
    const client = await this.ensureClient();
    this.routePrice ??=
      (await client.getRoutePrice(this.config.destination)) ?? 0n;
    return this.routePrice;
  }

  /**
   * What one blob upload costs, asked of the connector fronting the store node.
   *
   * Deliberately takes no size: TOON prices a route flat per packet (the
   * connector's ADR 0020), so a 2 KB avatar and a 2 MB screenshot cost the same
   * as long as both fit one packet. Callers that want to show "per upload"
   * rather than "per megabyte" are reading this correctly.
   *
   * Throws when the connector has no price for the store route. A null price
   * does NOT mean free — it means the edge is not terminating
   * `storeDestination` at all, so the packet would be refused downstream after
   * the user had already been told the upload was permanent and free. Treating
   * it as zero turns a routing outage into a silent wrong answer; the honest
   * report is that uploads are unavailable. The failure is also not cached, so
   * a route that comes back does not stay broken for the session.
   */
  async quoteStoreFee(): Promise<bigint> {
    const client = await this.ensureClient();
    if (this.storeRoutePrice !== null) return this.storeRoutePrice;

    const price = await client.getRoutePrice(this.config.storeDestination);
    if (price === null || price === undefined) {
      throw new ToonPaidWriteError(
        `The connector has no price for the store route ${this.config.storeDestination} — it is unpriced or unreachable, so uploads cannot be paid for.`,
      );
    }
    this.storeRoutePrice = price;
    return price;
  }

  /**
   * Upload bytes to the store node as a paid write, resolving with the Arweave
   * transaction id the bytes now live under.
   *
   * The write is permanent by construction — there is no companion `remove`,
   * and adding one would be a lie (see `mediaTombstone.ts`).
   */
  async uploadBlob(
    blobData: Uint8Array,
    contentType: string,
  ): Promise<{ txId: string; receipt: PaidWriteReceipt }> {
    const client = await this.ensureClient();
    const amount = await this.quoteStoreFee();

    const result = await client.uploadBlob({
      blobData,
      contentType,
      destination: this.config.storeDestination,
      ...(amount > 0n ? { ilpAmount: amount } : {}),
    });

    if (!result.success || !result.txId) {
      throw new ToonPaidWriteError(
        `The store node refused the upload: ${result.error ?? "no reason given"}`,
      );
    }

    const receipt: PaidWriteReceipt = {
      eventId: result.eventId ?? "",
      amount,
      assetScale: SETTLEMENT_ASSET_SCALE,
      asset: SETTLEMENT_ASSET,
      destination: this.config.storeDestination,
    };
    this.lastReceipt = receipt;
    for (const listener of this.listeners) listener(receipt);
    return { txId: result.txId, receipt };
  }

  /** Publish a signed event as a paid write, resolving with what it cost. */
  async publish(event: RelayEvent): Promise<PaidWriteReceipt> {
    const client = await this.ensureClient();
    const amount = await this.quoteFee();
    const channelId = await this.ensureChannelId(client);

    // Sign the claim ourselves (rather than letting `publishEvent` open/sign
    // internally) so the resumed channel id above is the one actually used,
    // and so the nonce watermark below persists BEFORE the claim goes out —
    // see `persistChannelProgress`.
    const proof = await client.signBalanceProof(channelId, amount);
    this.persistChannelProgress(channelId, proof);

    const result = await client.publishEvent(event, {
      destination: this.config.destination,
      claim: proof,
      ...(amount > 0n ? { ilpAmount: amount } : {}),
    });

    if (!result.success) {
      const refusal = result.refusedBy
        ? ` (refused by ${result.refusedBy})`
        : "";
      const code = result.code ? ` [${result.code}]` : "";
      throw new ToonPaidWriteError(
        `TOON refused the write${refusal}${code}: ${result.error ?? "no reason given"}`,
      );
    }

    this.captureSessionLease(client);

    const receipt: PaidWriteReceipt = {
      eventId: result.eventId ?? event.id,
      amount,
      assetScale: SETTLEMENT_ASSET_SCALE,
      asset: SETTLEMENT_ASSET,
      destination: this.config.destination,
    };
    this.lastReceipt = receipt;
    for (const listener of this.listeners) listener(receipt);
    return receipt;
  }

  /**
   * Ask the connector once whether it terminates the free ephemeral lane
   * (relay#129, toon-meta#393 epic E2) and what it charges, caching the
   * answer for the writer's lifetime — the connector this session pays does
   * not change mid-session, so there is nothing to invalidate. `null` means
   * the connector has no route for {@link ToonTransportConfig.ephemeralDestination}
   * at all: an old node that predates the lane, not a failure.
   */
  private async resolveEphemeralRoutePrice(
    client: PaidClient,
  ): Promise<bigint | null> {
    if (!this.ephemeralRouteChecked) {
      this.ephemeralRoutePrice = await client.getRoutePrice(
        this.config.ephemeralDestination,
      );
      this.ephemeralRouteChecked = true;
    }
    return this.ephemeralRoutePrice;
  }

  /**
   * Publish an ephemeral event (presence, typing) to the free ephemeral
   * write lane. Unlike {@link publish}, this never opens a channel or signs
   * a claim — the lane is a zero-priced route by construction, so there is
   * nothing to pay for or resume.
   *
   * Resolves without publishing when the connector does not terminate the
   * lane at all (an old node predating epic E2) — that is the documented
   * degrade to today's silent drop, not a failure. A connector that DOES
   * terminate the lane but refuses the write for some other reason (rate
   * limit, bad signature) still throws, same as {@link publish}; the caller
   * decides whether that loss is acceptable.
   */
  async publishEphemeral(event: RelayEvent): Promise<void> {
    const client = await this.ensureClient();
    const price = await this.resolveEphemeralRoutePrice(client);
    if (price === null) return;

    const result = await client.publishEvent(event, {
      destination: this.config.ephemeralDestination,
      ...(price > 0n ? { ilpAmount: price } : {}),
    });

    if (!result.success) {
      const refusal = result.refusedBy
        ? ` (refused by ${result.refusedBy})`
        : "";
      const code = result.code ? ` [${result.code}]` : "";
      throw new ToonPaidWriteError(
        `TOON refused the ephemeral write${refusal}${code}: ${result.error ?? "no reason given"}`,
      );
    }
  }

  /**
   * Pay one factory-job increment (buzz#85) — the buyer's half of
   * `docs/factory-job-protocol.md` §4.2's hashlock join. `destination` is the
   * PROVIDER's connector, never `this.config.destination` (the relay this
   * writer otherwise pays): decision 10 (toon-meta#262) makes multi-
   * destination channels over the same connector relationship the normal
   * case, not a special path, so this opens (or reuses — `openChannel` is
   * idempotent per peer) its own channel to `destination` rather than
   * touching the writer's single relay channel.
   *
   * `conditionHex` MUST be the kind:7000 `partial` offer's `condition` tag,
   * unmodified — it becomes the PREPARE's sender-chosen `executionCondition`
   * byte for byte. The connector verifies the returned fulfillment hashes
   * back to it before accepting; a mismatch or a missing fulfillment throws
   * rather than reporting success, since either would mean money moved with
   * no key to show for it.
   */
  async payFactoryJobIncrement(params: {
    destination: string;
    amountBaseUnits: bigint;
    /** The offer's `condition` tag: `sha256(key)`, 32 bytes hex. */
    conditionHex: string;
    /** The kind:7000 `partial` event id, carried in the PREPARE's `data` so a claim names the job it paid for. */
    jobEventId: string;
  }): Promise<FactoryJobIncrementPaymentReceipt> {
    if (!/^[0-9a-f]{64}$/i.test(params.conditionHex)) {
      throw new ToonPaidWriteError(
        `A factory job payment condition must be 32 bytes hex, got "${params.conditionHex}".`,
      );
    }

    const client = await this.ensureClient();
    let channelId: string;
    let result: Awaited<ReturnType<PaidClient["sendSwapPacket"]>>;
    try {
      channelId = await client.openChannel(params.destination);
      const proof = await client.signBalanceProof(
        channelId,
        params.amountBaseUnits,
      );
      result = await client.sendSwapPacket({
        destination: params.destination,
        amount: params.amountBaseUnits,
        toonData: new TextEncoder().encode(params.jobEventId),
        executionCondition: hexToBytes(params.conditionHex),
        claim: proof,
      });
    } catch (error) {
      console.error("Factory job increment payment failed", error);
      throw new ToonPaidWriteError(describeFactoryJobPaymentSetupError(error), {
        cause: error,
      });
    }

    if (!result.accepted) {
      const code = result.code ? ` [${result.code}]` : "";
      throw new ToonPaidWriteError(
        `The provider's connector refused the payment${code}: ${result.message ?? "no reason given"}`,
      );
    }
    if (!result.fulfillment) {
      throw new ToonPaidWriteError(
        "The payment was accepted but carried no fulfillment — the artifact key was not released.",
      );
    }

    this.captureSessionLease(client);

    const fulfillmentHex = bytesToHex(base64ToBytes(result.fulfillment));

    const receipt: PaidWriteReceipt = {
      eventId: params.jobEventId,
      amount: params.amountBaseUnits,
      assetScale: SETTLEMENT_ASSET_SCALE,
      asset: SETTLEMENT_ASSET,
      destination: params.destination,
    };
    this.lastReceipt = receipt;
    for (const listener of this.listeners) listener(receipt);

    return {
      fulfillmentHex,
      channelId,
      amount: params.amountBaseUnits,
      destination: params.destination,
    };
  }

  /**
   * Whether a channel exists to report on — this session's live channel, or
   * one persisted from an earlier launch. Guards every method below from
   * accidentally opening (and collateralizing) a fresh channel just because
   * a Settings panel asked to look at one: unlike `publish`'s `ensureChannelId`,
   * these calls must never *open* a channel as a side effect of reading or
   * managing an existing one.
   */
  private hasChannel(): boolean {
    return (
      this.channelId !== null ||
      hasPersistedChannel(this.config.destination, this.config.chain)
    );
  }

  private async requireChannelId(): Promise<{
    client: PaidClient;
    channelId: string;
  }> {
    if (!this.hasChannel()) {
      throw new ToonPaidWriteError(
        "No payment channel is open yet — it opens automatically on the first paid write.",
      );
    }
    const client = await this.ensureClient();
    const channelId = await this.ensureChannelId(client);
    return { client, channelId };
  }

  /**
   * The tracked payment channel's status for the Settings -> Payments card
   * (buzz#77), or `null` when none has ever opened for this destination.
   * Read-only: resumes a persisted channel's tracking state if needed, but
   * — see {@link hasChannel} — never opens a new one.
   */
  async getChannelStatus(): Promise<RawPaymentChannelStatus | null> {
    if (!this.hasChannel()) return null;
    const { client, channelId } = await this.requireChannelId();
    return {
      channelId,
      depositTotalBaseUnits: client.getChannelDepositTotal(channelId),
      cumulativeAmountBaseUnits: client.getChannelCumulativeAmount(channelId),
      closeState: client.getChannelCloseState(channelId),
      settleableAt: client.getSettleableAt(channelId) ?? null,
    };
  }

  /**
   * The deposit/owed pair the Money tab's Network spend block (#80) reads,
   * or `null` when no channel has ever opened for this destination — never
   * opens one as a side effect (same guard as {@link getChannelStatus}).
   *
   * Prefers the connector's claim-state endpoint (toon-meta#261 decision 5 —
   * the runway source of truth, correct even if this client's own watermark
   * has drifted). A connector that is unreachable, a `PaidClient` build that
   * predates `getClaimState`, or a response the connector could not verify
   * (`ok: false`) all fall back to this client's own locally-tracked read —
   * the "always-available free floor" decision 5 also calls for — so the
   * block degrades gracefully instead of going blank.
   */
  async getNetworkFlowStatus(): Promise<RawNetworkFlowStatus | null> {
    if (!this.hasChannel()) return null;
    const { client, channelId } = await this.requireChannelId();

    const verified = await this.tryClaimState(client, channelId);
    if (verified) {
      return { channelId, source: "claim-state", ...verified };
    }
    return {
      channelId,
      source: "local",
      depositTotalBaseUnits: client.getChannelDepositTotal(channelId),
      cumulativeClaimedBaseUnits: client.getChannelCumulativeAmount(channelId),
      creditedBaseUnits: 0n,
    };
  }

  /**
   * Ask the connector for `channelId`'s verified position. Never throws —
   * every failure (no `getClaimState` on this client build, an unreachable
   * connector, or a challenge the connector could not verify) reads as "no
   * verified answer", which {@link getNetworkFlowStatus} treats as a signal
   * to fall back to the local read, not as an error to surface.
   *
   * `cumulativeClaimed` is the connector's NETTED watermark for this one
   * channel (`@toon-protocol/client`'s "Earning" docs — earnings net
   * off-chain on the same channel a client spends from, there is no
   * separate earned ledger), so it can read below zero once this identity
   * has been credited more than it has spent. Split that signed watermark
   * into the two non-negative buckets {@link RawNetworkFlowStatus} carries
   * (`spendable = deposit − owed + credited`, toon-meta#262 decision 9)
   * rather than handing callers a watermark they'd each have to re-interpret.
   */
  private async tryClaimState(
    client: PaidClient,
    channelId: string,
  ): Promise<{
    depositTotalBaseUnits: bigint;
    cumulativeClaimedBaseUnits: bigint;
    creditedBaseUnits: bigint;
  } | null> {
    if (!client.getClaimState) return null;
    try {
      const [result] = await client.getClaimState([channelId]);
      if (!result?.ok) return null;
      return splitClaimStateWatermark(result);
    } catch (error) {
      console.warn(
        "[toon] claim-state read failed — falling back to the local channel record",
        error,
      );
      return null;
    }
  }

  /** Add collateral to the open channel. Throws if none is open. */
  async depositToChannel(
    amountBaseUnits: bigint,
  ): Promise<{ channelId: string; depositTotalBaseUnits: bigint }> {
    const { client, channelId } = await this.requireChannelId();
    const result = await client.depositToChannel(channelId, amountBaseUnits);
    return { channelId, depositTotalBaseUnits: BigInt(result.depositTotal) };
  }

  /** Begin the settlement grace period. Throws if no channel is open. */
  async closeChannel(): Promise<{
    channelId: string;
    closedAt: bigint;
    settleableAt: bigint;
  }> {
    const { client, channelId } = await this.requireChannelId();
    const result = await client.closeChannel(channelId);
    return {
      channelId,
      closedAt: BigInt(result.closedAt),
      settleableAt: BigInt(result.settleableAt),
    };
  }

  /**
   * Release collateral once the grace period has elapsed. Forgets the
   * persisted channel on success — a settled channel has nothing left to
   * resume, so keeping the record around would only make a future write try
   * to sign claims against a channel that no longer exists on-chain.
   */
  async settleChannel(): Promise<{ channelId: string; txHash?: string }> {
    const { client, channelId } = await this.requireChannelId();
    const result = await client.settleChannel(channelId);
    clearPersistedChannel(this.config.destination, this.config.chain);
    return result;
  }

  /** Release the client and its channel bookkeeping. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.starting = null;
    this.channelId = null;
    this.channelReady = null;
    await client?.stop();
  }

  private ensureClient(): Promise<PaidClient> {
    if (this.client !== null) return Promise.resolve(this.client);
    this.starting ??= (async () => {
      const jobDelivery = await this.ensureDeliveryPort();
      const client = await this.factory(this.config, jobDelivery ?? undefined);
      await client.start();
      this.client = client;
      return client;
    })().catch((error: unknown) => {
      this.starting = null;
      throw error instanceof ToonPaidWriteError
        ? error
        : new ToonPaidWriteError(
            `Could not start the TOON client: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
    });
    return this.starting;
  }

  /**
   * Construct the delivery port once, before the client, so the factory can
   * register `handleJob` at client construction — or `null` on an HTTP-only
   * transport, where no server-originated PREPARE could ever reach it.
   */
  private async ensureDeliveryPort(): Promise<ProviderJobDeliveryPort | null> {
    if (!this.supportsJobDelivery()) return null;
    this.deliveryPort ??= await createProviderJobDeliveryPort();
    return this.deliveryPort;
  }

  /** `config.chain` (e.g. `'evm:84532'`) as the context a resume needs. */
  private chainContext(): PersistedChannelContext {
    const parts = this.config.chain.split(":");
    const chainId = Number.parseInt(parts[parts.length - 1] ?? "", 10);
    return {
      chainType: parts[0] ?? "evm",
      chainId: Number.isFinite(chainId) ? chainId : 0,
      tokenNetworkAddress: this.config.tokenNetwork,
      tokenAddress: this.config.preferredToken,
    };
  }

  /**
   * Resume the channel persisted for (destination, chain), or open (and
   * persist) a fresh one when there is none — stale/corrupt persisted state
   * reads as "none" (see `toonChannelResumeStore`), same as a first launch.
   * Memoized for the writer's lifetime: this must run at most once, whether
   * that once resumes with zero on-chain writes or locks fresh collateral.
   */
  private ensureChannelId(client: PaidClient): Promise<string> {
    if (this.channelId !== null) return Promise.resolve(this.channelId);
    this.channelReady ??= (async () => {
      const persisted = loadPersistedChannel(
        this.config.destination,
        this.config.chain,
      );
      if (persisted !== null) {
        const manager = channelManagerOf(client);
        if (manager) {
          if (!manager.isTracking(persisted.channelId)) {
            manager.trackChannel(
              persisted.channelId,
              persisted.context,
              persisted.nonce,
              BigInt(persisted.cumulativeAmount),
            );
          }
          this.channelId = persisted.channelId;
          return persisted.channelId;
        }
        // `ToonClient`'s internals moved under `channelManagerOf`'s reflection
        // — fall through to a fresh open rather than sign against a channel
        // id nothing here can resume tracking for.
        console.warn(
          "[toon] could not resume the persisted payment channel (ToonClient internals changed) — opening a fresh one",
        );
      }

      const channelId = await client.openChannel(this.config.destination);
      savePersistedChannel(this.config.destination, this.config.chain, {
        channelId,
        context: this.chainContext(),
        nonce: 0,
        cumulativeAmount: "0",
      });
      this.channelId = channelId;
      return channelId;
    })();
    return this.channelReady;
  }

  /**
   * Persist the channel's nonce watermark, synchronously with claim
   * issuance and BEFORE the claim is sent over the network (see `publish`):
   * a crash after this write only risks wasting an unused nonce, never
   * resuming with a STALE one a connector has already accepted (which would
   * be rejected — F01 or equivalent — as a non-increasing nonce).
   */
  private persistChannelProgress(channelId: string, proof: BalanceProof): void {
    savePersistedChannel(this.config.destination, this.config.chain, {
      channelId,
      context: this.chainContext(),
      nonce: proof.nonce,
      cumulativeAmount: proof.transferredAmount.toString(),
    });
  }
}
