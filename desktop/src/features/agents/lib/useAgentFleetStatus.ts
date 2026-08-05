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
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import { useIdentityQuery } from "@/shared/api/hooks";
import { getActiveTransportSelection } from "@/shared/api/transportSelection";
import type { ManagedAgent } from "@/shared/api/types";

export type AgentFleetStatus = {
  runwayBadges: ReadonlyMap<string, AgentFleetRunwayBadge>;
  earningPubkeys: ReadonlySet<string>;
  unprovisionedPubkeys: ReadonlySet<string>;
};

/**
 * Per-agent runway badge (buzz#76), earning indicator (buzz#86 AC3), and
 * unprovisioned-wallet indicator (buzz#122 AC2) for the Agents grid, sharing
 * a single `useNetworkSpend(true)` read so the low-funds warning and the
 * earning badge never fetch the same self channel state twice. Only the
 * identity this desktop process itself pays as (account index 0) has a live
 * channel read today (buzz#79's ADR 0006 gap), so every other managed agent
 * maps to no runway badge / not-earning rather than a fabricated reading.
 * The unprovisioned indicator is unaffected by that gap — it is derived from
 * client-local state (`agentProvisioningStore.ts`), so it is accurate for
 * every managed agent, not just the self identity.
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

  // The provisioning declined/channel-confirmed flags are client-local
  // (buzz#122), unlike the network-derived runway/earning state above, so
  // every agent can read its own — not just the identity this process pays
  // as. The memo below re-reads them directly per agent rather than caching
  // them, so it only needs to know that *something* changed; the store's
  // version counter is a cheap stand-in for reading every agent's flags.
  const provisioningVersion = React.useSyncExternalStore(
    subscribeToAgentProvisioningState,
    getAgentProvisioningVersion,
  );
  const toonActive = getActiveTransportSelection()?.mode === "toon";

  // biome-ignore lint/correctness/useExhaustiveDependencies: provisioningVersion is never read in the body — it's a useSyncExternalStore snapshot that forces this memo to re-read the mutable agentProvisioningStore.ts flags below on any change
  return React.useMemo(() => {
    const runwayBadges = new Map<string, AgentFleetRunwayBadge>();
    const earningPubkeys = new Set<string>();
    const unprovisionedPubkeys = new Set<string>();
    for (const agent of agents) {
      const isSelf =
        currentPubkey !== undefined &&
        agent.pubkey.toLowerCase() === currentPubkey.toLowerCase();
      runwayBadges.set(agent.pubkey, isSelf ? selfBadge : null);
      if (isSelf && selfIsEarning) earningPubkeys.add(agent.pubkey);
      if (
        isAgentProvisioningUnprovisioned({
          toonActive,
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
    toonActive,
    provisioningVersion,
  ]);
}
