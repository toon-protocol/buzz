import * as React from "react";

import type { PaidWriteReceipt } from "@/shared/api/toonPaidWriter";

/**
 * Live in-session network spend for the Money tab's Network spend block
 * (#80) — module-level store + `useSyncExternalStore`, fed by
 * `ToonEventTransport.onPaidWrite`, per the epic's established idiom
 * (toon-meta#261). Feeds `burnRateBaseUnitsPerSec` into
 * `agentNetworkFlow.ts`'s `NetworkFlowRead` from this session's own
 * observed spend — the one burn signal available without the connector's
 * claim-state history (which reports a position, not a rate).
 *
 * Trailing-window, not cumulative: a write from ten minutes ago says
 * nothing about the CURRENT burn rate, so old receipts age out rather than
 * dragging the average down forever.
 */

const WINDOW_MS = 5 * 60 * 1000;

type Receipt = { amountBaseUnits: bigint; atMs: number };

export type LiveSpendSnapshot = {
  /** Sum of `amountBaseUnits` still inside the trailing window, / window length. */
  burnRateBaseUnitsPerSec: number;
  /** Whether any write has landed in the trailing window — see networkSpendState.ts's "not yet measured" caption. */
  hasSample: boolean;
};

/** The "nothing observed yet" snapshot — shared by any caller that needs a `LiveSpendSnapshot` without a live subscription (e.g. a non-`isSelf` read, which has no writes to observe from this process). */
export const EMPTY_SNAPSHOT: LiveSpendSnapshot = {
  burnRateBaseUnitsPerSec: 0,
  hasSample: false,
};

let receipts: Receipt[] = [];
// Referentially stable until the computed rate actually changes —
// `useSyncExternalStore` requires `getSnapshot` to return the same
// reference when nothing changed, or React logs an infinite-loop warning
// (CONTRIBUTING.md's React-perf gotcha: a fresh object every call defeats
// consumers just as surely as `React.memo` would be defeated by one).
let cachedSnapshot: LiveSpendSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Drop expired receipts and refresh `cachedSnapshot`, preserving its reference when the computed value is unchanged. */
function refreshCachedSnapshot(nowMs: number) {
  const cutoff = nowMs - WINDOW_MS;
  receipts = receipts.filter((receipt) => receipt.atMs >= cutoff);

  const next: LiveSpendSnapshot =
    receipts.length === 0
      ? EMPTY_SNAPSHOT
      : {
          burnRateBaseUnitsPerSec:
            Number(
              receipts.reduce(
                (sum, receipt) => sum + receipt.amountBaseUnits,
                0n,
              ),
            ) /
            (WINDOW_MS / 1000),
          hasSample: true,
        };

  if (
    next.hasSample !== cachedSnapshot.hasSample ||
    next.burnRateBaseUnitsPerSec !== cachedSnapshot.burnRateBaseUnitsPerSec
  ) {
    cachedSnapshot = next;
  }
}

/** Record one paid write. Registered on `ToonEventTransport.onPaidWrite` when TOON installs. */
export function recordNetworkSpendWrite(receipt: PaidWriteReceipt): void {
  receipts.push({ amountBaseUnits: receipt.amount, atMs: Date.now() });
  refreshCachedSnapshot(Date.now());
  notify();
}

export function subscribeNetworkSpendLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Current trailing-window snapshot. Stale entries age out lazily, on the
 * next call — a rate that stops updating because writes stopped is exactly
 * the "burn rate dropped to zero" case, so a caller (or a future refresh
 * affordance) re-reading this is what surfaces the decay; there is no
 * background timer here.
 */
export function getNetworkSpendLiveSnapshot(): LiveSpendSnapshot {
  refreshCachedSnapshot(Date.now());
  return cachedSnapshot;
}

/** Community-switch reset (see resetCommunityState in useCommunityInit) — a new relay is a new channel, a new burn rate. */
export function resetNetworkSpendLiveStore(): void {
  receipts = [];
  cachedSnapshot = EMPTY_SNAPSHOT;
  notify();
}

// Stable no-op pair for the `enabled: false` branch of useNetworkSpendLive —
// fresh functions per render would make useSyncExternalStore resubscribe (and
// re-read) every render, defeating the point of opting out.
const noopSubscribe = () => () => {};
const readEmptySnapshot = () => EMPTY_SNAPSHOT;

/**
 * Live burn-rate snapshot for the currently active TOON identity's channel.
 *
 * `enabled: false` returns {@link EMPTY_SNAPSHOT} without subscribing to the
 * store at all. This matters for always-mounted components that only need the
 * channel *position* (deposit/owed/credited), not the burn rate: the store is
 * fed from `onPaidWrite`, and during a huddle every ~20 ms audio frame is a
 * paid write — a subscription there means re-rendering at frame rate on the
 * renderer thread that is already handling the audio IPC stream (buzz#68
 * review finding on PR #196).
 */
export function useNetworkSpendLive(
  enabled: boolean = true,
): LiveSpendSnapshot {
  return React.useSyncExternalStore(
    enabled ? subscribeNetworkSpendLive : noopSubscribe,
    enabled ? getNetworkSpendLiveSnapshot : readEmptySnapshot,
  );
}
