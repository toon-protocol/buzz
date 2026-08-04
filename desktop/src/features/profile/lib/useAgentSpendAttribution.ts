import * as React from "react";

import {
  attributeObservedSpend,
  reconcileSpend,
  useObservedAgentEventsQuery,
  type SpendAttributionBreakdown,
  type SpendReconciliation,
} from "@/features/profile/lib/agentSpendAttribution";
import { useCommunities } from "@/features/communities/useCommunities";
import { useComposerFeeQuote } from "@/features/messages/lib/useComposerFeeQuote";
import type { NetworkSpendState } from "@/features/profile/lib/networkSpendState";
import {
  deriveSpendTrend,
  readSpendAttributionHistory,
  recordSpendAttributionCheckpoint,
  type SpendTrendPoint,
} from "@/features/profile/lib/spendAttributionHistoryStore";

/**
 * Wires `agentSpendAttribution.ts`'s pure attribution/reconciliation and
 * `spendAttributionHistoryStore.ts`'s persisted trend to real data for one
 * agent (buzz#78).
 *
 * The connector total (needed for `reconcileSpend` and for recording a
 * history checkpoint) only exists for `isSelf` today — see
 * `networkSpendState.ts`'s module doc for why. `network` is the caller's
 * already-fetched `NetworkSpendState` (from `useNetworkSpend`), not a second
 * independent read: `UserProfilePanelMoneyTab.tsx` fetches it once and
 * shares it with both the Network spend block and this hook, so viewing the
 * Money tab never asks the connector for the same channel's claim state
 * twice.
 */
export function useAgentSpendAttribution(params: {
  agentPubkey: string;
  isSelf: boolean;
  network: NetworkSpendState;
}): {
  isLoading: boolean;
  isError: boolean;
  breakdown: SpendAttributionBreakdown | null;
  reconciliation: SpendReconciliation | null;
  trend: SpendTrendPoint[];
} {
  const { activeCommunity } = useCommunities();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const pricePerEventBaseUnits = useComposerFeeQuote();
  const eventsQuery = useObservedAgentEventsQuery(params.agentPubkey);

  const connectorTotalBaseUnits =
    params.isSelf && params.network.kind === "quoted"
      ? params.network.read.owedBaseUnits
      : null;

  // Persist a checkpoint whenever a fresh connector total is available —
  // the only source of the periodic "exact total" this AC calls for, since
  // the claim-state watermark is cumulative-only and this is the moment it
  // was last read.
  React.useEffect(() => {
    if (!relayUrl || connectorTotalBaseUnits === null) return;
    recordSpendAttributionCheckpoint(relayUrl, params.agentPubkey, {
      atMs: Date.now(),
      cumulativeClaimedBaseUnits: connectorTotalBaseUnits,
    });
  }, [relayUrl, params.agentPubkey, connectorTotalBaseUnits]);

  const breakdown = React.useMemo(() => {
    if (!eventsQuery.data || pricePerEventBaseUnits === null) return null;
    return attributeObservedSpend(eventsQuery.data, pricePerEventBaseUnits);
  }, [eventsQuery.data, pricePerEventBaseUnits]);

  const reconciliation = React.useMemo(() => {
    if (!breakdown) return null;
    return reconcileSpend({
      attributedBaseUnits: breakdown.attributedBaseUnits,
      connectorTotalBaseUnits,
    });
  }, [breakdown, connectorTotalBaseUnits]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: connectorTotalBaseUnits isn't read in the body, but it's included so the trend re-reads history right after the effect above records a fresh checkpoint, not only on the next agent/relay switch.
  const trend = React.useMemo(() => {
    if (!relayUrl) return [];
    return deriveSpendTrend(
      readSpendAttributionHistory(relayUrl, params.agentPubkey),
    );
  }, [relayUrl, params.agentPubkey, connectorTotalBaseUnits]);

  return {
    isLoading: eventsQuery.isPending,
    isError: eventsQuery.isError,
    breakdown,
    reconciliation,
    trend,
  };
}
