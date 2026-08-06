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

/** Canonical claim-state fixtures a spec can select (buzz#131 AC2). */
export type MockToonClaimStateFixtureKind =
  | "funded"
  | "low-runway"
  | "stale-lease";

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
 * `@toon-protocol/client`'s `ClaimStateResult`. "funded" and "low-runway"
 * both answer `ok: true` with a deposit/cumulative-claimed pair scaled so
 * `netSpendableBaseUnits` (deposit − claimed) reads as a healthy balance or a
 * near-exhausted one; "stale-lease" answers `ok: false, error: "expired"` —
 * the connector's own name for a claim it will no longer honor — which
 * `ToonPaidWriter.tryClaimState` treats as no verified read, falling back to
 * this fake client's local channel numbers below.
 */
function buildMockClaimStateResult(kind: MockToonClaimStateFixtureKind) {
  const base = {
    blockchain: "evm" as const,
    channelId: MOCK_TOON_CHANNEL_ID,
    nonce: 1,
    lastClaimTime: Date.now(),
  };
  switch (kind) {
    case "funded":
      return {
        ...base,
        ok: true as const,
        depositTotal: "10000000",
        cumulativeClaimed: "50000",
        available: "9950000",
      };
    case "low-runway":
      return {
        ...base,
        ok: true as const,
        depositTotal: "1000000",
        cumulativeClaimed: "990000",
        available: "10000",
      };
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
