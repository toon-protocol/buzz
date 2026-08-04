import { normalizeRelayUrl } from "@/features/profile/lib/selfProfileStorage";

/**
 * Local history for the spend attribution trend (buzz#78 AC: "history
 * accumulates locally from observations plus periodic exact totals, enough
 * to draw a trend from a cumulative-only watermark").
 *
 * The connector's claim-state read (`RawNetworkFlowStatus.cumulativeClaimedBaseUnits`)
 * is a position, not a rate — a single read says "N spent so far", never
 * "spent M in the last hour". This module persists periodic checkpoints of
 * that watermark (localStorage, following `selfProfileStorage.ts`'s
 * relay+pubkey keying idiom — no existing time-series idiom to reuse, see
 * that module's header) and {@link deriveSpendTrend} turns consecutive
 * checkpoints into per-interval deltas a chart can draw.
 */

const STORAGE_KEY_PREFIX = "buzz-spend-attribution-history.v1";

/** Bounds localStorage usage — a trend chart does not need unbounded history, and a fixed cap keeps every write O(1)-ish regardless of session length. */
const MAX_CHECKPOINTS = 200;

/** One periodic exact-total observation: the connector's claim-state watermark at a point in time. */
export type SpendAttributionCheckpoint = {
  atMs: number;
  cumulativeClaimedBaseUnits: bigint;
};

/** A trend point: how much landed since the previous checkpoint, plus the running total. */
export type SpendTrendPoint = {
  atMs: number;
  deltaBaseUnits: bigint;
  cumulativeClaimedBaseUnits: bigint;
};

function storageKey(relayUrl: string, agentPubkey: string): string {
  return `${STORAGE_KEY_PREFIX}:${normalizeRelayUrl(relayUrl)}:${agentPubkey}`;
}

type StoredCheckpoint = { atMs: number; cumulativeClaimedBaseUnits: string };
type StoredHistory = { version: 1; checkpoints: StoredCheckpoint[] };

function parseStoredHistory(json: unknown): SpendAttributionCheckpoint[] {
  if (typeof json !== "object" || json === null) return [];
  const obj = json as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.checkpoints)) return [];

  const checkpoints: SpendAttributionCheckpoint[] = [];
  for (const entry of obj.checkpoints) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.atMs !== "number" ||
      typeof record.cumulativeClaimedBaseUnits !== "string"
    ) {
      continue;
    }
    try {
      checkpoints.push({
        atMs: record.atMs,
        cumulativeClaimedBaseUnits: BigInt(record.cumulativeClaimedBaseUnits),
      });
    } catch {
      // Malformed bigint string — skip this entry rather than the whole history.
    }
  }
  return checkpoints;
}

/** Read the persisted checkpoint history for one agent, oldest first. Returns an empty array on any storage or parse failure. */
export function readSpendAttributionHistory(
  relayUrl: string,
  agentPubkey: string,
): SpendAttributionCheckpoint[] {
  try {
    const raw = window.localStorage.getItem(storageKey(relayUrl, agentPubkey));
    if (!raw) return [];
    return parseStoredHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Append a checkpoint, bounded to {@link MAX_CHECKPOINTS} (oldest dropped
 * first). A checkpoint identical to the last recorded one is skipped — a
 * refresh with no new spend must not grow the stored array. Storage failures
 * (quota, private mode) are non-fatal: the live read still renders even when
 * history cannot persist.
 */
export function recordSpendAttributionCheckpoint(
  relayUrl: string,
  agentPubkey: string,
  checkpoint: SpendAttributionCheckpoint,
): void {
  try {
    const existing = readSpendAttributionHistory(relayUrl, agentPubkey);
    const last = existing[existing.length - 1];
    if (
      last &&
      last.cumulativeClaimedBaseUnits === checkpoint.cumulativeClaimedBaseUnits
    ) {
      return;
    }

    const next = [...existing, checkpoint].slice(-MAX_CHECKPOINTS);
    const stored: StoredHistory = {
      version: 1,
      checkpoints: next.map((entry) => ({
        atMs: entry.atMs,
        cumulativeClaimedBaseUnits: entry.cumulativeClaimedBaseUnits.toString(),
      })),
    };
    window.localStorage.setItem(
      storageKey(relayUrl, agentPubkey),
      JSON.stringify(stored),
    );
  } catch {
    // Non-fatal — see doc comment.
  }
}

/**
 * Turn checkpoints into trend points: each point's delta is the spend that
 * landed since the previous checkpoint. The first point (and any point where
 * the watermark went backwards — a channel reset/reopen resets the
 * cumulative-claimed counter) reports a zero delta rather than a negative
 * one; a reset is the start of a new series, not negative spend.
 */
export function deriveSpendTrend(
  checkpoints: readonly SpendAttributionCheckpoint[],
): SpendTrendPoint[] {
  const sorted = [...checkpoints].sort((left, right) => left.atMs - right.atMs);

  const trend: SpendTrendPoint[] = [];
  let previous: SpendAttributionCheckpoint | null = null;
  for (const checkpoint of sorted) {
    const delta =
      previous &&
      checkpoint.cumulativeClaimedBaseUnits >=
        previous.cumulativeClaimedBaseUnits
        ? checkpoint.cumulativeClaimedBaseUnits -
          previous.cumulativeClaimedBaseUnits
        : 0n;
    trend.push({
      atMs: checkpoint.atMs,
      deltaBaseUnits: delta,
      cumulativeClaimedBaseUnits: checkpoint.cumulativeClaimedBaseUnits,
    });
    previous = checkpoint;
  }
  return trend;
}
