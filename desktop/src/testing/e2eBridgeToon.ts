import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { recordNetworkSpendWrite } from "@/features/profile/lib/networkSpendLiveStore";
import type { ChannelCloseState } from "@/features/payments/lib/paymentsOverview";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { ProviderJobDeliveryPort } from "@/shared/api/toonJobDelivery";
import type { PaidClientFactory } from "@/shared/api/toonPaidWriter";
import type {
  ToonSocket,
  ToonSocketFactory,
} from "@/shared/api/toonRelayReader";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Test-double TOON transport for the e2e harness (buzz#131).
 *
 * `installSelectedTransport` (`transportSelection.ts`) builds a real
 * `ToonPaidWriter`/`ToonRelayReader` against `@toon-protocol/client` and the
 * devnet, which a bridged Playwright run has no business reaching. This
 * module is the fake substitute the e2e bridge installs instead — a
 * `PaidClientFactory` that never touches the network and answers
 * `getClaimState` from a fixture the spec controls, plus a `ToonSocketFactory`
 * that opens instantly and answers reads from a spec-seeded fixture list
 * (buzz#134 AC1) rather than a live relay (nothing in these specs needs a
 * real WebSocket — chat/channel reads stay on the Tauri-mocked path
 * regardless of transport mode).
 *
 * Extracted from `e2eBridge.ts` (see `e2eBridgeCustomHarnesses.ts` for the
 * same rationale) so the fake client logic is unit-testable without a full
 * browser/Playwright context.
 */

/** Canonical claim-state fixtures a spec can select (buzz#131 AC2, buzz#133 AC1). */
export type MockToonClaimStateFixtureKind =
  | "funded"
  | "low-runway"
  | "stale-lease"
  | "depleted";

/**
 * The fake channel id every mock TOON operation resolves to. Exported so the
 * bridge's persisted-channel seed (`e2eBridge.ts`) and this client's own
 * `openChannel`/`getClaimState` answers agree on the same id, though the
 * exact value is mostly cosmetic — `ToonPaidWriter.ensureChannelId` replaces
 * a seeded record with whatever `openChannel` returns on first read.
 */
export const MOCK_TOON_CHANNEL_ID = "e2e-mock-toon-channel";

/**
 * The connector's claim-state answer for each fixture, shaped like
 * `@toon-protocol/client`'s `ClaimStateResult`. Every `ok: true` fixture
 * picks a deposit/cumulative-claimed pair whose difference is the spendable
 * balance (`netSpendableBaseUnits`) the Money tab and the fleet runway badge
 * read back; the one `ok: false` fixture stands in for a claim the connector
 * no longer honors. What each fixture's numbers are chosen to surface is
 * noted on its case below.
 */
function buildMockClaimStateResult(kind: MockToonClaimStateFixtureKind) {
  const base = {
    blockchain: "evm" as const,
    channelId: MOCK_TOON_CHANNEL_ID,
    nonce: 1,
    lastClaimTime: Date.now(),
  };
  switch (kind) {
    // A healthy balance: 9.95 USDC spendable.
    case "funded":
      return {
        ...base,
        ok: true as const,
        depositTotal: "10000000",
        cumulativeClaimed: "50000",
        available: "9950000",
      };
    // Near-exhausted but non-zero: 0.01 USDC spendable, small enough that a
    // seeded burn rate (see `seedMockNetworkBurnRateReceipt`) lands the fleet
    // runway badge inside a warning band rather than a healthy runway.
    case "low-runway":
      return {
        ...base,
        ok: true as const,
        depositTotal: "1000000",
        cumulativeClaimed: "990000",
        available: "10000",
      };
    // Deposit === claimed, i.e. a spendable balance of exactly zero
    // (buzz#133) — `agentFleetRunway.ts`'s "critical"/"Out of funds" branch
    // via `deriveNetworkRunway`'s "depleted" case, and the only badge level
    // reachable without a live burn-rate sample.
    case "depleted":
      return {
        ...base,
        ok: true as const,
        depositTotal: "500000",
        cumulativeClaimed: "500000",
        available: "0",
      };
    // "expired" is the connector's own name for a claim it will no longer
    // honor. `ToonPaidWriter.tryClaimState` treats it as no verified read and
    // falls back to this fake client's local channel numbers below.
    case "stale-lease":
      return {
        blockchain: base.blockchain,
        channelId: base.channelId,
        ok: false as const,
        error: "expired" as const,
      };
  }
}

/**
 * Build the `PaidClientFactory` the e2e bridge installs in place of the real
 * `createToonClient`. `getClaimStateFixture` is read at CALL time (not
 * captured once), so a spec that mutates `window.__BUZZ_E2E__.mock.toonClaimState`
 * mid-test sees the new fixture on its next `refresh()` — same live-read
 * convention every other `window.__BUZZ_E2E_*` config field in this bridge
 * follows.
 *
 * `getSessionLeaseTtlMsFixture` (buzz#134 AC3) answers `getLastConnectorRouteTerms`
 * — `undefined` (the default) reproduces the pre-buzz#134 behaviour exactly
 * (no lease ever observed, `ToonPaidWriter.getSessionLease()` stays
 * `undefined` forever, so `useProviderAvailability` can only ever read
 * `pending`). This too is read at CALL time, and that matters more than for
 * the claim-state fixture: `captureSessionLease` runs after EVERY successful
 * paid write, so a TTL seeded at install would be captured by whichever paid
 * write lands first, before a spec can observe `pending`. (The kind:20001
 * presence heartbeat used to be that first write; as of buzz#212 it is
 * dropped rather than paid for — see `ToonEventTransport.publish` — so it no
 * longer races this fixture, though the same care still applies to any other
 * early write, e.g. a quote.) A spec that wants `available`/`stale` therefore
 * starts with the TTL absent and sets
 * `window.__BUZZ_E2E__.mock.toonSessionLeaseTtlMs` live mid-test — the next
 * successful write captures the lease, exactly like the real `ToonClient`.
 *
 * `onJobDeliveryPort` (buzz#135) is called with the REAL
 * `ClientJobDeliveryPort` `ToonPaidWriter.ensureClient()` constructs and
 * would otherwise register as `ToonClientConfig.jobHandler` — this fake
 * client has no connector to route a server-originated PREPARE through, so
 * the bridge captures the port instance itself and drives it directly (see
 * `payArmedFactoryJobIncrement`) to simulate "the buyer paid".
 */
export function createE2eToonPaidClient(
  getClaimStateFixture: () => MockToonClaimStateFixtureKind | undefined,
  getSessionLeaseTtlMsFixture: () => number | undefined = () => undefined,
  onJobDeliveryPort?: (port: ProviderJobDeliveryPort) => void,
): PaidClientFactory {
  return async (_config, jobDelivery) => {
    if (jobDelivery) onJobDeliveryPort?.(jobDelivery);
    return {
      async start() {
        return undefined;
      },
      async stop() {
        return undefined;
      },
      async getRoutePrice() {
        return 0n;
      },
      async openChannel() {
        return MOCK_TOON_CHANNEL_ID;
      },
      async signBalanceProof(channelId: string, amount: bigint) {
        return { channelId, nonce: 1, transferredAmount: amount };
      },
      async publishEvent(event: RelayEvent) {
        return { success: true, eventId: event.id };
      },
      getLastConnectorRouteTerms() {
        const sessionLeaseTtlMs = getSessionLeaseTtlMsFixture();
        return sessionLeaseTtlMs === undefined
          ? undefined
          : { extra: { session_lease_ttl_ms: sessionLeaseTtlMs } };
      },
      async uploadBlob() {
        return {
          success: true,
          txId: "e2e-mock-toon-tx",
          eventId: "e2e-mock-toon-blob",
        };
      },
      async sendSwapPacket() {
        return { accepted: true, fulfillment: btoa("e2e-mock-fulfillment") };
      },
      getChannelCumulativeAmount() {
        return 100000n;
      },
      getChannelDepositTotal() {
        return 500000n;
      },
      getChannelCloseState(): ChannelCloseState {
        return "open";
      },
      getSettleableAt() {
        return undefined;
      },
      async getClaimState() {
        return [buildMockClaimStateResult(getClaimStateFixture() ?? "funded")];
      },
      async depositToChannel(channelId: string, amount: string | bigint) {
        const total = typeof amount === "bigint" ? amount : BigInt(amount);
        return { channelId, depositTotal: total.toString() };
      },
      async closeChannel(channelId: string) {
        const now = String(Date.now());
        return { channelId, closedAt: now, settleableAt: now };
      },
      async settleChannel(channelId: string) {
        return { channelId };
      },
    };
  };
}

/**
 * Whether a seeded fixture event satisfies a NIP-01 filter, covering exactly
 * the fields the factory-jobs hooks actually send: `kinds`, `authors`, and
 * `#e`/`#p` tag filters (`RelaySubscriptionFilter`'s tag keys). Not a general
 * NIP-01 matcher — `since`/`until`/`ids` are unused by every caller today and
 * deliberately left unimplemented rather than guessed at.
 */
function eventMatchesFilter(
  event: RelayEvent,
  filter: RelaySubscriptionFilter,
): boolean {
  if (filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    // Every `#`-prefixed filter key carries `string[]` per
    // `RelaySubscriptionFilter` — the cast below just recovers what
    // `Object.entries`'s value union (shared with `kinds`/`limit`) erased.
    const tagValues = values as string[];
    const tagName = key.slice(1);
    const matched = event.tags.some(
      ([name, value]) => name === tagName && tagValues.includes(value),
    );
    if (!matched) return false;
  }
  return true;
}

/**
 * Build a `ToonSocketFactory` whose sockets fire `open` on the next tick.
 * `getSeededEvents` (buzz#134 AC1) is read at REQ time, not captured once —
 * same live-read convention as `getClaimStateFixture` above — so a spec can
 * seed fixture job/quote/feedback events before navigating and have every
 * `REQ` answered from that list, filtered the same way a real relay would
 * (`eventMatchesFilter`), followed by an immediate `EOSE`. The default (no
 * seeded events) reproduces the pre-buzz#134 behaviour: every subscription
 * still opens and gets EOSE (nothing to hold `fetchEvents`/`subscribeLive`
 * open on their 25s/250ms fallbacks), it just never carries any events —
 * exactly what "a relay with nothing to send yet" means. This fake socket
 * only ever answers what was seeded BEFORE the REQ arrived; it never pushes
 * a live event after the fact (no bridged spec needs that yet — see the
 * module doc).
 */
export function createE2eToonSocketFactory(
  getSeededEvents: () => RelayEvent[] = () => [],
): ToonSocketFactory {
  return () => {
    const openListeners = new Set<() => void>();
    const messageListeners = new Set<(event: { data: unknown }) => void>();
    const emitFrame = (frame: unknown[]) => {
      const data = JSON.stringify(frame);
      for (const listener of messageListeners) listener({ data });
    };
    const socket = {
      send(data: string) {
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        if (!Array.isArray(payload) || payload[0] !== "REQ") return;
        const [, subscriptionId, filter] = payload as [
          string,
          unknown,
          unknown,
        ];
        if (typeof subscriptionId !== "string" || !filter) return;

        const matches = getSeededEvents().filter((event) =>
          eventMatchesFilter(event, filter as RelaySubscriptionFilter),
        );
        queueMicrotask(() => {
          for (const event of matches) {
            emitFrame(["EVENT", subscriptionId, event]);
          }
          emitFrame(["EOSE", subscriptionId]);
        });
      },
      close() {
        // Nothing to tear down for a socket that never really opened.
      },
      addEventListener(type: string, listener: (event?: unknown) => void) {
        if (type === "open") {
          openListeners.add(listener as () => void);
        } else if (type === "message") {
          messageListeners.add(listener as (event: { data: unknown }) => void);
        }
        // "close"/"error" listeners are accepted but never fired — this fake
        // socket never drops.
      },
    };
    queueMicrotask(() => {
      for (const listener of openListeners) listener();
    });
    return socket as unknown as ToonSocket;
  };
}

/**
 * Seed one receipt into `networkSpendLiveStore.ts`'s trailing-window burn
 * tracker (buzz#133) — the only source `agentFleetRunway.ts`'s "warning"
 * badge level (a finite, non-depleted runway) ever reads a burn rate from.
 * Claim-state fixtures alone cannot reach it: `getRoutePrice` on this fake
 * client always answers `0n` (no route pricing to fake here), so a real
 * bridged write never produces a nonzero receipt on its own. A spec picks
 * `amountBaseUnits` together with a claim-state fixture's spendable balance
 * to land on a specific runway — see `tests/e2e/agent-fleet-runway.spec.ts`
 * for the arithmetic (a single receipt over the tracker's fixed 5-minute
 * window gives an exact, non-decaying-within-the-test burn rate).
 */
export function seedMockNetworkBurnRateReceipt(amountBaseUnits: bigint): void {
  recordNetworkSpendWrite({
    amount: amountBaseUnits,
    asset: "USDC",
    assetScale: 6,
    destination: MOCK_TOON_CHANNEL_ID,
    eventId: "e2e-mock-burn-seed",
  });
}

/**
 * Simulate "the buyer paid the armed increment" (buzz#135) by calling the
 * job-delivery port's `handleJob` directly — the same `JobHandler` a real
 * `ToonClient` would register as `ToonClientConfig.jobHandler` and a real
 * connector would invoke as a server-originated BTP MESSAGE carrying the
 * buyer's paying PREPARE. `conditionHex` must be the offer's own `condition`
 * tag: `ClientJobDeliveryPort.handleJob` refuses (throws) any condition it
 * did not just stage via `encryptArtifact` + arm via `waitForPayment` — see
 * `@toon-protocol/rig`'s `ClientJobDeliveryPort` doc for the one-armed-
 * increment-at-a-time contract this enforces.
 *
 * Resolves the fulfillment (hex) `handleJob` released — the artifact's
 * decryption key — so a spec can assert it decrypts the offer's ciphertext,
 * exactly like a real buyer's payment receipt would.
 */
export async function payArmedFactoryJobIncrement(
  port: ProviderJobDeliveryPort,
  conditionHex: string,
): Promise<string> {
  const answer = await port.handleJob({
    amount: 0n,
    destination: "e2e-mock-buyer-destination",
    executionCondition: hexToBytes(conditionHex),
    expiresAt: new Date(Date.now() + 60_000),
    data: new Uint8Array(),
  });
  return bytesToHex(answer.fulfillment);
}
