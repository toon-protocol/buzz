import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { decryptObserverEvent } from "@/shared/api/tauriObserver";
import { KIND_AGENT_TURN_METRIC } from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Model usage block (buzz#75) — the "postpaid, estimated" half of the Money
 * tab's two-block, never-summed layout. Reads kind:44200 NIP-AM agent turn
 * metrics, a channel that already flows (buzz-acp publishes it, the desktop
 * already subscribes to and archives it) but renders nowhere today.
 *
 * Deliberately queries the relay directly rather than the local archive: NIP-AM
 * events are relay-persisted (unlike ephemeral kind 24200 observer frames), so
 * they're readable without opting into local archiving first. The relay's
 * result-gate on kind:44200 requires the reader to be the `#p`-tagged owner —
 * exactly the `ownerPubkey` this module is called with.
 */

/** Turn/cumulative token-usage counters, as decrypted from a NIP-AM payload. */
export type AgentTurnTokenCounts = {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

/** One parsed kind:44200 event, reduced to the fields the Money tab aggregates. */
export type AgentTurnMetric = {
  eventId: string;
  createdAt: number;
  model: string | null;
  sessionId: string | null;
  turnSeq: number | null;
  turn: AgentTurnTokenCounts | null;
  cumulative: AgentTurnTokenCounts | null;
};

/** The Model usage block's aggregate over every fetched turn metric. */
export type AgentModelUsageSummary = {
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  turnCount: number;
  lastModel: string | null;
  lastActivityAt: number | null;
};

/**
 * Latest N turn-metric events considered per agent. One event per completed
 * turn (not per message frame), so this comfortably covers an agent's full
 * recorded history without the paged-scroll machinery the much higher-volume
 * kind:24200 observer archive needs.
 */
const METRIC_FETCH_LIMIT = 500;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Rejects negative/non-finite values — a malformed or hostile payload must not corrupt the aggregate. */
function asNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseTokenCounts(value: unknown): AgentTurnTokenCounts | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  return {
    inputTokens: asNonNegativeFiniteNumber(record.inputTokens),
    outputTokens: asNonNegativeFiniteNumber(record.outputTokens),
    costUsd: asNonNegativeFiniteNumber(record.costUsd),
  };
}

/**
 * Parse a decrypted kind:44200 payload into an {@link AgentTurnMetric}.
 * Returns `null` when `harness` (the one NIP-AM-required field this module
 * depends on) is missing — a payload that fails this basic shape check is
 * not worth aggregating.
 */
export function parseAgentTurnMetric(
  event: Pick<RelayEvent, "id" | "created_at">,
  decrypted: unknown,
): AgentTurnMetric | null {
  const record = asRecord(decrypted);
  if (!asString(record.harness)) return null;

  return {
    eventId: event.id,
    createdAt: event.created_at,
    model: asString(record.model),
    sessionId: asString(record.sessionId),
    turnSeq: asNonNegativeFiniteNumber(record.turnSeq),
    turn: parseTokenCounts(record.turn),
    cumulative: parseTokenCounts(record.cumulative),
  };
}

function addToken(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

/**
 * Aggregate parsed turn metrics into the Model usage summary.
 *
 * Groups by `sessionId` and takes each session's last event (by `turnSeq`,
 * falling back to `createdAt`) — a session's `cumulative` counts already fold
 * in every earlier turn, so summing per-turn deltas on top would double
 * count. Events without a `sessionId` fall back to summing their own `turn`
 * (or `cumulative`, if that's all they carry) directly.
 *
 * Returns `null` for an empty input — the caller renders this as an honest
 * empty state, not a zero (buzz#75 AC).
 */
export function aggregateAgentModelUsage(
  metrics: AgentTurnMetric[],
): AgentModelUsageSummary | null {
  if (metrics.length === 0) return null;

  const bySession = new Map<string, AgentTurnMetric[]>();
  const sessionless: AgentTurnMetric[] = [];
  for (const metric of metrics) {
    if (metric.sessionId) {
      const list = bySession.get(metric.sessionId);
      if (list) {
        list.push(metric);
      } else {
        bySession.set(metric.sessionId, [metric]);
      }
    } else {
      sessionless.push(metric);
    }
  }

  let totalInputTokens: number | null = null;
  let totalOutputTokens: number | null = null;
  let totalCostUsd: number | null = null;

  const applyCounts = (counts: AgentTurnTokenCounts | null) => {
    if (!counts) return;
    totalInputTokens = addToken(totalInputTokens, counts.inputTokens);
    totalOutputTokens = addToken(totalOutputTokens, counts.outputTokens);
    totalCostUsd = addToken(totalCostUsd, counts.costUsd);
  };

  for (const sessionMetrics of bySession.values()) {
    const latest = sessionMetrics.reduce((best, candidate) => {
      const bestSeq = best.turnSeq ?? -1;
      const candidateSeq = candidate.turnSeq ?? -1;
      if (candidateSeq !== bestSeq) {
        return candidateSeq > bestSeq ? candidate : best;
      }
      return candidate.createdAt > best.createdAt ? candidate : best;
    });
    applyCounts(latest.cumulative ?? latest.turn);
  }

  for (const metric of sessionless) {
    applyCounts(metric.turn ?? metric.cumulative);
  }

  const mostRecent = metrics.reduce((best, candidate) =>
    candidate.createdAt > best.createdAt ? candidate : best,
  );

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    turnCount: metrics.length,
    lastModel: mostRecent.model,
    lastActivityAt: mostRecent.createdAt,
  };
}

/** Injectable I/O for {@link fetchAgentModelUsage} — production uses the relay + Tauri decrypt; tests inject fakes. */
export type AgentModelUsageDeps = {
  fetchEvents: (
    agentPubkey: string,
    ownerPubkey: string,
  ) => Promise<RelayEvent[]>;
  decryptEvent: (event: RelayEvent) => Promise<unknown>;
};

const defaultDeps: AgentModelUsageDeps = {
  fetchEvents: (agentPubkey, ownerPubkey) =>
    relayClient.fetchEvents({
      kinds: [KIND_AGENT_TURN_METRIC],
      authors: [agentPubkey.toLowerCase()],
      "#p": [ownerPubkey.toLowerCase()],
      limit: METRIC_FETCH_LIMIT,
    }),
  decryptEvent: decryptObserverEvent,
};

/**
 * Fetch and decrypt `agentPubkey`'s kind:44200 turn metrics (as read by
 * `ownerPubkey`), and aggregate them into a Model usage summary.
 *
 * A single event that fails to decrypt (wrong key, malformed ciphertext) is
 * dropped rather than failing the whole fetch — one bad turn record must not
 * blank the rest of an agent's usage history.
 */
export async function fetchAgentModelUsage(
  agentPubkey: string,
  ownerPubkey: string,
  deps: AgentModelUsageDeps = defaultDeps,
): Promise<AgentModelUsageSummary | null> {
  const events = await deps.fetchEvents(agentPubkey, ownerPubkey);

  const metrics: AgentTurnMetric[] = [];
  for (const event of events) {
    try {
      const decrypted = await deps.decryptEvent(event);
      const parsed = parseAgentTurnMetric(event, decrypted);
      if (parsed) metrics.push(parsed);
    } catch {
      // Skip: undecryptable or malformed turn record.
    }
  }

  return aggregateAgentModelUsage(metrics);
}

export function agentModelUsageQueryKey(
  agentPubkey: string,
  ownerPubkey: string,
) {
  return [
    "agent-model-usage",
    agentPubkey.toLowerCase(),
    ownerPubkey.toLowerCase(),
  ] as const;
}

/**
 * Query the Money tab's Model usage summary for one agent.
 *
 * `enabled` requires both pubkeys: the data is owner-scoped (billed to the
 * owner's own provider account), so callers must gate this on `viewerIsOwner`
 * before passing a non-null `ownerPubkey`.
 */
export function useAgentModelUsageQuery(
  agentPubkey: string | null | undefined,
  ownerPubkey: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const enabled =
    (options?.enabled ?? true) && Boolean(agentPubkey) && Boolean(ownerPubkey);

  return useQuery<AgentModelUsageSummary | null>({
    enabled,
    queryKey: agentModelUsageQueryKey(agentPubkey ?? "", ownerPubkey ?? ""),
    queryFn: () =>
      fetchAgentModelUsage(agentPubkey as string, ownerPubkey as string),
    staleTime: 30_000,
  });
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Format a token count with locale grouping (e.g. `12,345`). */
export function formatTokenCount(count: number): string {
  return count.toLocaleString();
}

/**
 * Format an estimated USD cost. Sub-cent per-turn costs are the common case
 * for a single LLM call, so a fixed 2dp would render most turns as "$0.00" —
 * widen to 4dp under a cent, same reasoning as `formatUsdcBaseUnits`.
 */
export function formatModelUsageCostUsd(costUsd: number): string {
  const decimals = costUsd > 0 && costUsd < 0.01 ? 4 : 2;
  return costUsd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
