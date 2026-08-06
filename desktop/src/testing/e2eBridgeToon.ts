import { recordNetworkSpendWrite } from "@/features/profile/lib/networkSpendLiveStore";
import type { ChannelCloseState } from "@/features/payments/lib/paymentsOverview";
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
 * that opens instantly and never sends real frames (nothing in these specs
 * needs live channel data over TOON — chat/channel reads stay on the
 * Tauri-mocked path regardless of transport mode).
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
 */
export function createE2eToonPaidClient(
  getClaimStateFixture: () => MockToonClaimStateFixtureKind | undefined,
): PaidClientFactory {
  return async () => ({
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
  });
}

/**
 * Build a `ToonSocketFactory` whose sockets fire `open` on the next tick and
 * otherwise do nothing — `ToonRelayReader.ready()`/`subscribeLive()` resolve
 * quickly (no real WebSocket, no devnet reachability needed) and every send
 * is a no-op, so a subscription just sits open with no messages, exactly as
 * a real reader would behave against a relay with nothing to send yet.
 */
export function createE2eToonSocketFactory(): ToonSocketFactory {
  return () => {
    const openListeners = new Set<() => void>();
    const socket = {
      send() {
        // No real wire — nothing in these specs asserts on outgoing frames.
      },
      close() {
        // Nothing to tear down for a socket that never really opened.
      },
      addEventListener(type: string, listener: (event?: unknown) => void) {
        if (type === "open") {
          openListeners.add(listener as () => void);
        }
        // "message"/"close"/"error" listeners are accepted but never fired —
        // this fake socket never receives real frames or drops.
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
