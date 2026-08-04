import * as React from "react";

import { isAgentFleetEarning } from "@/features/agents/lib/agentFleetRunway";
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ManagedAgent } from "@/shared/api/types";

/**
 * Per-agent earning badge for the Agents grid (buzz#86 AC3) — the "pays for
 * itself" counterpart to `useAgentFleetRunwayBadges`'s low-funds warning.
 * Same `isSelf`-only gate: only the identity this desktop process itself
 * pays as (account index 0) has a live channel read today (buzz#79's ADR
 * 0006 gap), so every other managed agent maps to `false` rather than a
 * fabricated reading.
 */
export function useAgentFleetEarningBadges(
  agents: readonly ManagedAgent[],
): ReadonlySet<string> {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const selfSpend = useNetworkSpend(true);
  const selfIsEarning = React.useMemo(
    () => isAgentFleetEarning(selfSpend.state),
    [selfSpend.state],
  );

  return React.useMemo(() => {
    const earningPubkeys = new Set<string>();
    if (!selfIsEarning || currentPubkey === undefined) return earningPubkeys;
    for (const agent of agents) {
      if (agent.pubkey.toLowerCase() === currentPubkey.toLowerCase()) {
        earningPubkeys.add(agent.pubkey);
      }
    }
    return earningPubkeys;
  }, [agents, currentPubkey, selfIsEarning]);
}
