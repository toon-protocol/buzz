import type { AgentFleetRunwayBadge } from "@/features/agents/lib/agentFleetRunway";
import { useAgentFleetStatus } from "@/features/agents/lib/useAgentFleetStatus";
import type { ManagedAgent } from "@/shared/api/types";

/**
 * Per-agent runway badges for the Agents grid + sidebar low-funds alert
 * (buzz#76). Only the identity this desktop process itself pays as
 * (account index 0) has a live channel read today — see
 * `networkSpendState.ts`'s module doc — so every other managed agent maps
 * to `null` (no badge) rather than a fabricated or stale figure. That is a
 * real, documented architectural gap (buzz#79's ADR 0006), not something
 * this hook works around.
 */
export function useAgentFleetRunwayBadges(
  agents: readonly ManagedAgent[],
): ReadonlyMap<string, AgentFleetRunwayBadge> {
  return useAgentFleetStatus(agents).runwayBadges;
}
