import * as React from "react";

import {
  deriveAgentFleetRunwayBadge,
  type AgentFleetRunwayBadge,
} from "@/features/agents/lib/agentFleetRunway";
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import { useIdentityQuery } from "@/shared/api/hooks";
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
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const selfSpend = useNetworkSpend(true);
  const selfBadge = React.useMemo(
    () => deriveAgentFleetRunwayBadge(selfSpend.state),
    [selfSpend.state],
  );

  return React.useMemo(() => {
    const badgeByPubkey = new Map<string, AgentFleetRunwayBadge>();
    for (const agent of agents) {
      const isSelf =
        currentPubkey !== undefined &&
        agent.pubkey.toLowerCase() === currentPubkey.toLowerCase();
      badgeByPubkey.set(agent.pubkey, isSelf ? selfBadge : null);
    }
    return badgeByPubkey;
  }, [agents, currentPubkey, selfBadge]);
}
