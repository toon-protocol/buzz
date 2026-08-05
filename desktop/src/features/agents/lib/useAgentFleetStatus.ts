import * as React from "react";

import {
  deriveAgentFleetRunwayBadge,
  isAgentFleetEarning,
  type AgentFleetRunwayBadge,
} from "@/features/agents/lib/agentFleetRunway";
import { isAgentProvisioningUnprovisioned } from "@/features/agents/lib/agentProvisioningBadge";
import {
  getAgentProvisioningVersion,
  isAgentChannelConfirmed,
  isAgentProvisioningDeclined,
  subscribeToAgentProvisioningState,
} from "@/features/agents/lib/agentProvisioningStore";
import { useAgentFleetMoneyReads } from "@/features/agents/lib/useAgentFleetMoneyReads";
import { EMPTY_SNAPSHOT } from "@/features/profile/lib/networkSpendLiveStore";
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
  unprovisionedPubkeys: ReadonlySet<string>;
};

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
 * Per-agent runway badge (buzz#76), earning indicator (buzz#86 AC3), and
 * unprovisioned-wallet indicator (buzz#122 AC2) for the Agents grid.
 *
 * Every managed agent gets a real money read now (buzz#109 /
 * `docs/adr/0007`), not only the identity this desktop process itself pays
 * as:
 *
 * - The `isSelf` agent shares the existing `useNetworkSpend` read (its live
 *   writer, with a local-watermark fallback).
 * - Every other agent is read via `useAgentFleetMoneyReads`' ONE batched
 *   claim-state request for the whole non-self set, so N agents in the
 *   fleet never cost N connector round trips.
 *
 * An agent with no discovered channel (never provisioned, or provisioned
 * but never opened one) still maps to no badge / not-earning — the same
 * honest `unavailable` `deriveNetworkSpendState` already produces, never a
 * fabricated reading.
 *
 * The unprovisioned indicator is independent of all of that: it derives from
 * client-local state (`agentProvisioningStore.ts`) rather than a network
 * read, so it stays accurate for every managed agent whether or not a
 * channel was ever discovered for it.
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

  // The provisioning declined/channel-confirmed flags are client-local
  // (buzz#122), unlike the network-derived runway/earning state above. The
  // memo below re-reads them directly per agent rather than caching them, so
  // it only needs to know that *something* changed; the store's version
  // counter is a cheap stand-in for reading every agent's flags.
  const provisioningVersion = React.useSyncExternalStore(
    subscribeToAgentProvisioningState,
    getAgentProvisioningVersion,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: provisioningVersion is never read in the body — it's a useSyncExternalStore snapshot that forces this memo to re-read the mutable agentProvisioningStore.ts flags below on any change
  return React.useMemo(() => {
    const runwayBadges = new Map<string, AgentFleetRunwayBadge>();
    const earningPubkeys = new Set<string>();
    const unprovisionedPubkeys = new Set<string>();
    for (const agent of agents) {
      if (isSelfAgent(agent.pubkey, currentPubkey)) {
        runwayBadges.set(agent.pubkey, selfBadge);
        if (selfIsEarning) earningPubkeys.add(agent.pubkey);
      } else {
        // No fleet agent's writes are observed from this process — see
        // `useNetworkSpend.ts`'s module doc on why a non-`isSelf` read never
        // has a burn-rate sample.
        const state: NetworkSpendState = deriveNetworkSpendState({
          isToon,
          raw: otherRaw.get(agent.pubkey) ?? null,
          live: EMPTY_SNAPSHOT,
        });
        runwayBadges.set(agent.pubkey, deriveAgentFleetRunwayBadge(state));
        if (isAgentFleetEarning(state)) earningPubkeys.add(agent.pubkey);
      }

      if (
        isAgentProvisioningUnprovisioned({
          toonActive: isToon,
          channelConfirmed: isAgentChannelConfirmed(agent.pubkey),
          declined: isAgentProvisioningDeclined(agent.pubkey),
        })
      ) {
        unprovisionedPubkeys.add(agent.pubkey);
      }
    }
    return { runwayBadges, earningPubkeys, unprovisionedPubkeys };
  }, [
    agents,
    currentPubkey,
    selfBadge,
    selfIsEarning,
    otherRaw,
    isToon,
    provisioningVersion,
  ]);
}
