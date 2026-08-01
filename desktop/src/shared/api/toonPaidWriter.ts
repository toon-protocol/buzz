import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";
import type { RelayEvent } from "@/shared/api/types";

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

/** TOON settles in USDC on every chain the devnet offers. */
const SETTLEMENT_ASSET = "USDC";
const SETTLEMENT_ASSET_SCALE = 6;

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

/** Thrown when a paid write cannot be attempted or the packet was refused. */
export class ToonPaidWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToonPaidWriteError";
  }
}

/** The subset of `ToonClient` this module drives. */
type PaidClient = {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  getRoutePrice(destination: string): Promise<bigint | null>;
  publishEvent(
    event: RelayEvent,
    options?: { destination?: string; ilpAmount?: bigint },
  ): Promise<{
    success: boolean;
    eventId?: string;
    error?: string;
    code?: string;
    refusedBy?: string;
  }>;
};

export type PaidClientFactory = (
  config: ToonTransportConfig,
) => Promise<PaidClient>;

/**
 * Build a real `ToonClient` for `config`.
 *
 * `supportedChains` and `chainRpcUrls` are both load-bearing and easy to
 * mistake for optional: the client only constructs an on-chain channel client
 * when `chainRpcUrls` is set, and without one the first write dies with "No
 * channel client configured" *after* the user has already sent a message.
 */
const createToonClient: PaidClientFactory = async (config) => {
  if (config.mnemonic === null) {
    throw new ToonPaidWriteError(
      "No TOON payment identity configured (BUZZ_TOON_MNEMONIC).",
    );
  }

  const [{ ToonClient }, { encodeEventToToon, decodeEventFromToon }] =
    await Promise.all([
      import("@toon-protocol/client"),
      import("@toon-protocol/core"),
    ]);

  return new ToonClient({
    mnemonic: config.mnemonic,
    mnemonicAccountIndex: config.accountIndex,
    proxyUrl: config.proxyUrl,
    relayUrl: config.relayUrl,
    destinationAddress: config.destination,
    ilpInfo: {
      pubkey: "00".repeat(32),
      ilpAddress: "g.toon.client",
      btpEndpoint: "",
      assetCode: SETTLEMENT_ASSET,
      assetScale: SETTLEMENT_ASSET_SCALE,
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    supportedChains: [config.chain],
    chainRpcUrls: { [config.chain]: config.chainRpcUrl },
    tokenNetworks: { [config.chain]: config.tokenNetwork },
    preferredTokens: { [config.chain]: config.preferredToken },
  }) as unknown as PaidClient;
};

export class ToonPaidWriter {
  private readonly config: ToonTransportConfig;
  private readonly factory: PaidClientFactory;
  private readonly listeners = new Set<PaidWriteListener>();
  private client: PaidClient | null = null;
  private starting: Promise<PaidClient> | null = null;
  private routePrice: bigint | null = null;
  private lastReceipt: PaidWriteReceipt | null = null;

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

  /** The most recent paid write's cost, for status surfaces. */
  getLastReceipt(): PaidWriteReceipt | null {
    return this.lastReceipt;
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

  /** Publish a signed event as a paid write, resolving with what it cost. */
  async publish(event: RelayEvent): Promise<PaidWriteReceipt> {
    const client = await this.ensureClient();
    const amount = await this.quoteFee();

    const result = await client.publishEvent(event, {
      destination: this.config.destination,
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

  /** Release the client and its channel bookkeeping. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.starting = null;
    await client?.stop();
  }

  private ensureClient(): Promise<PaidClient> {
    if (this.client !== null) return Promise.resolve(this.client);
    this.starting ??= (async () => {
      const client = await this.factory(this.config);
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
}
