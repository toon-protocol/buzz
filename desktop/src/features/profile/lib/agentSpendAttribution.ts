import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import {
  CHANNEL_TIMELINE_CONTENT_KINDS,
  KIND_REACTION,
} from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Spend attribution (buzz#78, toon-meta#261 decision 6): reconcile the
 * connector's authoritative claim-state total against relay-observed agent
 * events (kind, chat channel, timestamp — the desktop already sees these for
 * free, the same way `agentModelUsage.ts` reads kind:44200 directly off the
 * relay rather than a local cache).
 *
 * Two halves:
 * - {@link attributeObservedSpend}: group an agent's relay-observed events by
 *   (channel, kind) and price them, flat per event — TOON prices a route flat
 *   per packet (`toonPaidWriter.ts`'s `transportEndpointFields` doc), so every
 *   write to the same destination costs the connector the same amount
 *   regardless of kind.
 * - {@link reconcileSpend}: compare the attributed total against the
 *   connector's claim-state total (`RawNetworkFlowStatus.cumulativeClaimedBaseUnits`,
 *   read via `ToonPaidWriter.getNetworkFlowStatus()`) and surface the gap as
 *   an explicit unattributed remainder — spend in channels the owner cannot
 *   see. Per the issue's AC, this remainder is never redistributed across the
 *   visible breakdown to make it "add up".
 *
 * The events fetch (`fetchObservedAgentEvents`) works for ANY agent, not just
 * `isSelf` — it is a plain author-scoped relay query, and the relay itself
 * already scopes results to channels the requester (the owner) is a member
 * of, which is exactly what makes an agent active in an owner-invisible
 * channel read as a genuine remainder rather than a wrong breakdown.
 * `reconcileSpend` itself is agent-agnostic too — it just takes whatever
 * `connectorTotalBaseUnits` its caller passes, `null` or not. The caller
 * (`useAgentSpendAttribution.ts`) currently only ever passes one for
 * `isSelf`, a scope choice for this block specifically (see
 * `UserProfilePanelSpendAttribution.tsx`'s module doc), not an
 * architectural limit — a non-`isSelf` connector total is available since
 * buzz#109 (`docs/adr/0007`). An agent without a connector total still gets
 * a real breakdown, just with `reconcileSpend`'s `"unverified"` state
 * instead of a fabricated remainder.
 */

/** Kinds worth attributing: content an agent authors that costs a paid write. Ephemeral kinds (huddle audio, typing) are excluded because the relay never stores them — there is nothing to query historically, not a scoping choice. */
export const AGENT_SPEND_ATTRIBUTION_EVENT_KINDS: readonly number[] = [
  ...CHANNEL_TIMELINE_CONTENT_KINDS,
  KIND_REACTION,
];

/** Latest N events considered per agent — mirrors `agentModelUsage.ts`'s `METRIC_FETCH_LIMIT`. */
const EVENT_FETCH_LIMIT = 1000;

/** One relay-observed, channel-scoped event an agent authored. */
export type ObservedAgentEvent = {
  eventId: string;
  channelId: string;
  kind: number;
  createdAt: number;
};

/** The `h` (NIP-29 channel) tag off a raw event, or null for an untagged event (DMs, etc. — out of scope for channel attribution). */
export function eventChannelId(
  tags: readonly (readonly string[])[],
): string | null {
  for (const tag of tags) {
    if (tag[0] === "h" && tag[1]) return tag[1];
  }
  return null;
}

/** Reduce raw relay events to the channel-scoped subset attribution can price. */
export function toObservedAgentEvents(
  events: readonly Pick<RelayEvent, "id" | "kind" | "created_at" | "tags">[],
): ObservedAgentEvent[] {
  const observed: ObservedAgentEvent[] = [];
  for (const event of events) {
    const channelId = eventChannelId(event.tags);
    if (channelId === null) continue;
    observed.push({
      eventId: event.id,
      channelId,
      kind: event.kind,
      createdAt: event.created_at,
    });
  }
  return observed;
}

/** Attributed spend for one (channel, kind) pair. */
export type ChannelKindSpend = {
  channelId: string;
  kind: number;
  eventCount: number;
  baseUnits: bigint;
};

export type SpendAttributionBreakdown = {
  attributedBaseUnits: bigint;
  byChannelKind: ChannelKindSpend[];
};

/**
 * Attribute spend across an agent's relay-observed events, priced flat per
 * event. Sorted by (channel, kind) for a stable, deterministic breakdown —
 * callers rendering a table should not need to re-sort.
 */
export function attributeObservedSpend(
  events: readonly ObservedAgentEvent[],
  pricePerEventBaseUnits: bigint,
): SpendAttributionBreakdown {
  const byKey = new Map<string, ChannelKindSpend>();
  for (const event of events) {
    const key = `${event.channelId} ${event.kind}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.eventCount += 1;
      existing.baseUnits += pricePerEventBaseUnits;
    } else {
      byKey.set(key, {
        channelId: event.channelId,
        kind: event.kind,
        eventCount: 1,
        baseUnits: pricePerEventBaseUnits,
      });
    }
  }

  const byChannelKind = [...byKey.values()].sort((left, right) =>
    left.channelId === right.channelId
      ? left.kind - right.kind
      : left.channelId.localeCompare(right.channelId),
  );

  const attributedBaseUnits = byChannelKind.reduce(
    (sum, entry) => sum + entry.baseUnits,
    0n,
  );

  return { attributedBaseUnits, byChannelKind };
}

export type SpendReconciliation =
  /** No connector total exists to reconcile against yet — never read as a zero remainder. */
  | { kind: "unverified"; attributedBaseUnits: bigint }
  | {
      kind: "reconciled";
      attributedBaseUnits: bigint;
      connectorTotalBaseUnits: bigint;
      /** Spend in channels the owner cannot see. Never redistributed across `byChannelKind` — surfaced as-is, per the issue's AC. */
      unattributedRemainderBaseUnits: bigint;
    };

/**
 * Reconcile the attributed (relay-observed) total against the connector's
 * authoritative claim-state total.
 */
export function reconcileSpend(params: {
  attributedBaseUnits: bigint;
  connectorTotalBaseUnits: bigint | null;
}): SpendReconciliation {
  if (params.connectorTotalBaseUnits === null) {
    return {
      kind: "unverified",
      attributedBaseUnits: params.attributedBaseUnits,
    };
  }

  const remainder = params.connectorTotalBaseUnits - params.attributedBaseUnits;
  return {
    kind: "reconciled",
    attributedBaseUnits: params.attributedBaseUnits,
    connectorTotalBaseUnits: params.connectorTotalBaseUnits,
    // Floored at zero: a stale/racy pair of reads (an event observed just
    // after publish but before the connector's claim watermark advances, or
    // vice versa) must never render as a negative remainder — same floor
    // `netSpendableBaseUnits` (agentNetworkFlow.ts) applies for the same
    // reason.
    unattributedRemainderBaseUnits: remainder > 0n ? remainder : 0n,
  };
}

/** Injectable I/O for {@link fetchObservedAgentEvents} — production reads the relay directly; tests inject fakes. */
export type AgentSpendAttributionDeps = {
  fetchEvents: (agentPubkey: string) => Promise<RelayEvent[]>;
};

const defaultDeps: AgentSpendAttributionDeps = {
  fetchEvents: (agentPubkey) =>
    relayClient.fetchEvents({
      kinds: [...AGENT_SPEND_ATTRIBUTION_EVENT_KINDS],
      authors: [agentPubkey.toLowerCase()],
      limit: EVENT_FETCH_LIMIT,
    }),
};

/**
 * Fetch `agentPubkey`'s relay-observed, channel-scoped events. Works for any
 * agent — see the module doc for why this is not `isSelf`-gated.
 */
export async function fetchObservedAgentEvents(
  agentPubkey: string,
  deps: AgentSpendAttributionDeps = defaultDeps,
): Promise<ObservedAgentEvent[]> {
  const events = await deps.fetchEvents(agentPubkey);
  return toObservedAgentEvents(events);
}

export function agentSpendAttributionQueryKey(agentPubkey: string) {
  return ["agent-spend-attribution-events", agentPubkey.toLowerCase()] as const;
}

/**
 * Query an agent's relay-observed events for spend attribution. Deliberately
 * returns only the events — pricing and reconciliation are cheap, pure, and
 * depend on inputs (the route's quoted fee, the connector's claim-state
 * total) that change independently of the event history, so callers combine
 * them with {@link attributeObservedSpend}/{@link reconcileSpend} rather than
 * this hook re-fetching on every price tick.
 */
export function useObservedAgentEventsQuery(
  agentPubkey: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = (options?.enabled ?? true) && Boolean(agentPubkey);

  return useQuery<ObservedAgentEvent[]>({
    enabled,
    queryKey: agentSpendAttributionQueryKey(agentPubkey ?? ""),
    queryFn: () => fetchObservedAgentEvents(agentPubkey as string),
    staleTime: 30_000,
  });
}
