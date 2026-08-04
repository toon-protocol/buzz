import * as React from "react";

import {
  deriveAgentFleetRunwayBadge,
  isAgentFleetEarning,
  type AgentFleetRunwayBadge,
} from "@/features/agents/lib/agentFleetRunway";
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ManagedAgent } from "@/shared/api/types";

export type AgentFleetStatus = {
  runwayBadges: ReadonlyMap<string, AgentFleetRunwayBadge>;
  earningPubkeys: ReadonlySet<string>;
};

/**
 * Per-agent runway badge (buzz#76) + earning indicator (buzz#86 AC3) for the
 * Agents grid, sharing a single `useNetworkSpend(true)` read so the
 * low-funds warning and the earning badge never fetch the same self channel
 * state twice. Only the identity this desktop process itself pays as
 * (account index 0) has a live channel read today (buzz#79's ADR 0006 gap),
 * so every other managed agent maps to no badge / not-earning rather than a
 * fabricated reading.
 */
export function useAgentFleetStatus(
  agents: readonly ManagedAgent[],
): AgentFleetStatus {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const selfSpend = useNetworkSpend(true);
  const selfBadge = React.useMemo(
    () => deriveAgentFleetRunwayBadge(selfSpend.state),
    [selfSpend.state],
  );
  const selfIsEarning = React.useMemo(
    () => isAgentFleetEarning(selfSpend.state),
    [selfSpend.state],
  );

  return React.useMemo(() => {
    const runwayBadges = new Map<string, AgentFleetRunwayBadge>();
    const earningPubkeys = new Set<string>();
    for (const agent of agents) {
      const isSelf =
        currentPubkey !== undefined &&
        agent.pubkey.toLowerCase() === currentPubkey.toLowerCase();
      runwayBadges.set(agent.pubkey, isSelf ? selfBadge : null);
      if (isSelf && selfIsEarning) earningPubkeys.add(agent.pubkey);
    }
    return { runwayBadges, earningPubkeys };
  }, [agents, currentPubkey, selfBadge, selfIsEarning]);
}
