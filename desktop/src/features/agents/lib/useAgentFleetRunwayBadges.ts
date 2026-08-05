import type { AgentFleetRunwayBadge } from "@/features/agents/lib/agentFleetRunway";
import { useAgentFleetStatus } from "@/features/agents/lib/useAgentFleetStatus";
import type { ManagedAgent } from "@/shared/api/types";

/**
 * Per-agent runway badges for the Agents grid + sidebar low-funds alert
 * (buzz#76). Every managed agent gets a real channel read now (buzz#109 —
 * see `useAgentFleetStatus.ts`'s module doc and `docs/adr/0007`), not only
 * the identity this desktop process itself pays as — an agent with no
 * discovered channel still maps to `null` (no badge), never a fabricated or
 * stale figure.
 */
export function useAgentFleetRunwayBadges(
  agents: readonly ManagedAgent[],
): ReadonlyMap<string, AgentFleetRunwayBadge> {
  return useAgentFleetStatus(agents).runwayBadges;
}
