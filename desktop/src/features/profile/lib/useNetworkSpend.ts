import * as React from "react";

import {
  readAgentsNetworkFlowStatus,
  type AgentClaimStateReadConfig,
} from "@/features/profile/lib/agentClaimStateRead";
import {
  canRefillNetworkSpend,
  deriveNetworkSpendState,
  type NetworkSpendState,
} from "@/features/profile/lib/networkSpendState";
import {
  useNetworkSpendLive,
  type LiveSpendSnapshot,
} from "@/features/profile/lib/networkSpendLiveStore";
import { getManagedAgentAccountIndex } from "@/shared/api/tauriAgentProvisioning";
import {
  getActiveToonTransport,
  getActiveTransportSelection,
} from "@/shared/api/transportSelection";
import type { RawNetworkFlowStatus } from "@/shared/api/toonPaidWriter";

/**
 * Wires `networkSpendState.ts`'s pure derivation to the network reads and
 * the refill action the Money tab's Network spend block needs (#80).
 * Follows `usePaymentsOverview.ts`'s shape: an explicit, re-triggerable
 * `refresh` rather than a background poll, so a tab a user glances at and
 * leaves does not keep spending the connector's attention.
 *
 * `isSelf` still picks the read path (buzz#109 / `docs/adr/0007`):
 *
 * - `isSelf`: the live writer's own tracked channel — unchanged from before
 *   this ticket, including its local-watermark fallback when the connector
 *   is unreachable, and the only session with a live burn-rate sample.
 * - non-`isSelf`: a one-shot, no-daemon read for `agentPubkey`'s own
 *   account index — real data, never a fabricated one, but with no burn-rate
 *   sample (nothing observes another identity's writes from this process).
 *
 * `canDeposit` stays `isSelf`-only regardless of the read: a deposit always
 * lands on `getActiveToonTransport()`'s own writer, i.e. the identity this
 * desktop process itself pays as. Funding a *different* agent's channel is
 * buzz#74's provisioning flow, not this refill action — enabling it here
 * would silently deposit into the wrong channel while the panel displays
 * another agent's balance.
 */
export function useNetworkSpend(agentPubkey: string, isSelf: boolean) {
  const selection = getActiveTransportSelection();
  const isToon = selection?.mode === "toon";
  const config = selection?.config ?? null;
  const selfLive = useNetworkSpendLive();
  const live: LiveSpendSnapshot = isSelf
    ? selfLive
    : { burnRateBaseUnitsPerSec: 0, hasSample: false };

  const [raw, setRaw] = React.useState<RawNetworkFlowStatus | null | "pending">(
    "pending",
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const [depositPending, setDepositPending] = React.useState(false);
  const [depositError, setDepositError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!isToon) {
      setRaw(null);
      return;
    }
    setRefreshing(true);
    try {
      const status = isSelf
        ? ((await getActiveToonTransport()
            ?.getPaidWriter()
            .getNetworkFlowStatus()) ?? null)
        : await readSingleAgentNetworkFlowStatus(config, agentPubkey);
      setRaw(status);
    } catch (error) {
      console.error("[network-spend] refresh failed", error);
      setRaw(null);
    } finally {
      setRefreshing(false);
    }
  }, [isToon, isSelf, config, agentPubkey]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const deposit = React.useCallback(
    async (amountBaseUnits: bigint): Promise<boolean> => {
      if (!isSelf) return false;
      const writer = getActiveToonTransport()?.getPaidWriter();
      if (!writer) return false;
      setDepositError(null);
      setDepositPending(true);
      try {
        await writer.depositToChannel(amountBaseUnits);
        await refresh();
        return true;
      } catch (error) {
        setDepositError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setDepositPending(false);
      }
    },
    [isSelf, refresh],
  );

  const state: NetworkSpendState = deriveNetworkSpendState({
    isToon,
    raw,
    live,
  });

  return {
    state,
    refresh,
    refreshing,
    deposit,
    canDeposit: isSelf && canRefillNetworkSpend(state),
    depositPending,
    depositError,
  };
}

/**
 * A one-shot claim-state read for one non-`isSelf` agent — resolves its
 * account index (buzz#79's registry, already exposed to the frontend) then
 * delegates to `agentClaimStateRead.ts`'s batched primitive with a single
 * entry. `null` (never thrown outward) when `config` is unset, or the agent
 * has no assigned account index yet (not provisioned) — both read the same
 * as "no channel", which `deriveNetworkSpendState` already renders as
 * `unavailable`.
 */
async function readSingleAgentNetworkFlowStatus(
  config: AgentClaimStateReadConfig | null,
  agentPubkey: string,
): Promise<RawNetworkFlowStatus | null> {
  if (config === null) return null;
  const accountIndex = await getManagedAgentAccountIndex(agentPubkey);
  if (accountIndex === null) return null;
  const results = await readAgentsNetworkFlowStatus(config, [
    { pubkey: agentPubkey, accountIndex },
  ]);
  return results.get(agentPubkey) ?? null;
}
