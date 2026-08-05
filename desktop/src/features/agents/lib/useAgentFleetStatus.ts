import * as React from "react";

import {
  deriveAgentFleetRunwayBadge,
  isAgentFleetEarning,
  type AgentFleetRunwayBadge,
} from "@/features/agents/lib/agentFleetRunway";
import { useAgentFleetMoneyReads } from "@/features/agents/lib/useAgentFleetMoneyReads";
import {
  deriveNetworkSpendState,
  type NetworkSpendState,
} from "@/features/profile/lib/networkSpendState";
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ManagedAgent } from "@/shared/api/types";
import { getActiveTransportSelection } from "@/shared/api/transportSelection";

export type AgentFleetStatus = {
  runwayBadges: ReadonlyMap<string, AgentFleetRunwayBadge>;
  earningPubkeys: ReadonlySet<string>;
};

/** No fleet agent's writes are observed from this process — see `useNetworkSpend.ts`'s module doc on why a non-`isSelf` read never has a burn-rate sample. */
const NO_LIVE_SAMPLE = { burnRateBaseUnitsPerSec: 0, hasSample: false };

function isSelfAgent(
  pubkey: string,
  currentPubkey: string | undefined,
): boolean {
  return (
    currentPubkey !== undefined &&
    pubkey.toLowerCase() === currentPubkey.toLowerCase()
  );
}

/**
 * Per-agent runway badge (buzz#76) + earning indicator (buzz#86 AC3) for the
 * Agents grid. Every managed agent gets a real read now (buzz#109 /
 * `docs/adr/0007`), not only the identity this desktop process itself pays
 * as:
 *
 * - The `isSelf` agent shares the existing `useNetworkSpend` read (its live
 *   writer, with a local-watermark fallback) — unchanged from before this
 *   ticket.
 * - Every other agent is read via `useAgentFleetMoneyReads`' ONE batched
 *   claim-state request for the whole non-self set, so N agents in the
 *   fleet never cost N connector round trips.
 *
 * An agent with no discovered channel (never provisioned, or provisioned
 * but never opened one) still maps to no badge / not-earning — the same
 * honest `unavailable` `deriveNetworkSpendState` already produces, never a
 * fabricated reading.
 */
export function useAgentFleetStatus(
  agents: readonly ManagedAgent[],
): AgentFleetStatus {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const isToon = getActiveTransportSelection()?.mode === "toon";

  const selfSpend = useNetworkSpend(currentPubkey ?? "", true);
  const selfBadge = React.useMemo(
    () => deriveAgentFleetRunwayBadge(selfSpend.state),
    [selfSpend.state],
  );
  const selfIsEarning = React.useMemo(
    () => isAgentFleetEarning(selfSpend.state),
    [selfSpend.state],
  );

  const otherPubkeys = React.useMemo(
    () =>
      agents
        .filter((agent) => !isSelfAgent(agent.pubkey, currentPubkey))
        .map((agent) => agent.pubkey),
    [agents, currentPubkey],
  );
  const otherRaw = useAgentFleetMoneyReads(otherPubkeys);

  return React.useMemo(() => {
    const runwayBadges = new Map<string, AgentFleetRunwayBadge>();
    const earningPubkeys = new Set<string>();
    for (const agent of agents) {
      if (isSelfAgent(agent.pubkey, currentPubkey)) {
        runwayBadges.set(agent.pubkey, selfBadge);
        if (selfIsEarning) earningPubkeys.add(agent.pubkey);
        continue;
      }
      const state: NetworkSpendState = deriveNetworkSpendState({
        isToon,
        raw: otherRaw.get(agent.pubkey) ?? null,
        live: NO_LIVE_SAMPLE,
      });
      runwayBadges.set(agent.pubkey, deriveAgentFleetRunwayBadge(state));
      if (isAgentFleetEarning(state)) earningPubkeys.add(agent.pubkey);
    }
    return { runwayBadges, earningPubkeys };
  }, [agents, currentPubkey, selfBadge, selfIsEarning, otherRaw, isToon]);
}
