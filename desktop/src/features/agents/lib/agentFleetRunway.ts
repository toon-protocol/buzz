import {
  deriveNetworkRunway,
  isEarning,
  type NetworkFlowRead,
} from "@/features/profile/lib/agentNetworkFlow";
import type { NetworkSpendState } from "@/features/profile/lib/networkSpendState";

/**
 * Fleet-glance runway badge for `AgentIdentityCard` + the sidebar low-funds
 * alert (buzz#76, part of the agent-fleet-money epic toon-meta#261). Reuses
 * buzz#80's `NetworkSpendState`/`agentNetworkFlow.ts` runway derivation
 * rather than re-deriving it, per this ticket's own instruction.
 *
 * Thresholds are days-of-runway (burn-rate-relative), never absolute USDC,
 * so a warning stays meaningful across a pricing change.
 */

export const AGENT_FLEET_RUNWAY_CRITICAL_DAYS = 1;
export const AGENT_FLEET_RUNWAY_WARNING_DAYS = 3;

const SECONDS_PER_DAY = 86_400;

export type AgentFleetRunwayLevel = "critical" | "warning";

export type AgentFleetRunwayBadge = {
  level: AgentFleetRunwayLevel;
  label: string;
} | null;

/**
 * Null covers every state that is not an actionable warning: healthy
 * runway, self-funding, and `unavailable` (no channel ever discovered for
 * that agent — buzz#109 / `docs/adr/0007`). An absent read must never be
 * dressed up as a healthy one; it shows nothing, same as before this ticket.
 */
export function deriveAgentFleetRunwayBadge(
  state: NetworkSpendState,
): AgentFleetRunwayBadge {
  if (state.kind !== "quoted") return null;
  return runwayBadgeForRead(state.read);
}

/**
 * Whether `state` shows a fleet agent that pays for itself — the
 * `AgentIdentityCard` earning badge predicate (buzz#86 AC3). Same
 * `state.kind !== "quoted"` gate as {@link deriveAgentFleetRunwayBadge} and
 * the same trusted-income bar as the badge's own self-funding branch, so
 * the earning badge and the low-funds suppression never disagree about
 * whether an agent is self-funding.
 */
export function isAgentFleetEarning(state: NetworkSpendState): boolean {
  if (state.kind !== "quoted") return false;
  return isEarning(state.read);
}

function runwayBadgeForRead(read: NetworkFlowRead): AgentFleetRunwayBadge {
  const runway = deriveNetworkRunway(read);
  if (runway.kind === "depleted") {
    return { level: "critical", label: "Out of funds" };
  }
  if (runway.kind === "self-funding") return null;

  const runwayDays = runway.runwaySeconds / SECONDS_PER_DAY;
  if (runwayDays < AGENT_FLEET_RUNWAY_CRITICAL_DAYS) {
    return { level: "critical", label: formatRunwayLabel(runwayDays) };
  }
  if (runwayDays < AGENT_FLEET_RUNWAY_WARNING_DAYS) {
    return { level: "warning", label: formatRunwayLabel(runwayDays) };
  }
  return null;
}

function formatRunwayLabel(runwayDays: number): string {
  if (runwayDays < 1) {
    const hours = Math.max(1, Math.round(runwayDays * 24));
    return `${hours} hr${hours === 1 ? "" : "s"} left`;
  }
  const days = Math.round(runwayDays);
  return `${days} day${days === 1 ? "" : "s"} left`;
}

const RUNWAY_SORT_WEIGHT: Record<AgentFleetRunwayLevel, number> = {
  critical: 0,
  warning: 1,
};

/**
 * Sort weight so starving agents rise to the top of the Agents grid —
 * critical, then warning, then everything else at an equal, unranked tier.
 */
export function agentFleetRunwaySortWeight(
  badge: AgentFleetRunwayBadge,
): number {
  return badge ? RUNWAY_SORT_WEIGHT[badge.level] : 2;
}

/**
 * Sort `items` so the most-starving agents surface first. `badgeOf` is
 * evaluated once per item up front (it can be as expensive as picking and
 * sorting a group's agents) rather than on every comparison. Uses
 * `Array.sort`, which is stable — items with the same (or no) badge keep
 * their existing relative order rather than being shuffled.
 */
export function sortByFleetRunway<T>(
  items: readonly T[],
  badgeOf: (item: T) => AgentFleetRunwayBadge,
): T[] {
  return items
    .map((item) => ({
      item,
      weight: agentFleetRunwaySortWeight(badgeOf(item)),
    }))
    .sort((a, b) => a.weight - b.weight)
    .map(({ item }) => item);
}

/** The sidebar low-funds alert's count — how many fleet agents need attention right now. */
export function countLowFundsAgents(
  badges: Iterable<AgentFleetRunwayBadge>,
): number {
  let count = 0;
  for (const badge of badges) {
    if (badge) count += 1;
  }
  return count;
}
