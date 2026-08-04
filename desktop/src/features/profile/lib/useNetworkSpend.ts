import * as React from "react";

import {
  canRefillNetworkSpend,
  deriveNetworkSpendState,
  type NetworkSpendState,
} from "@/features/profile/lib/networkSpendState";
import { useNetworkSpendLive } from "@/features/profile/lib/networkSpendLiveStore";
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
 * `isSelf` gates every network read — see `networkSpendState.ts`'s module
 * doc for why only the identity this desktop process itself pays as has a
 * channel to read at all today.
 */
export function useNetworkSpend(isSelf: boolean) {
  const selection = getActiveTransportSelection();
  const isToon = selection?.mode === "toon";
  const live = useNetworkSpendLive();

  const [raw, setRaw] = React.useState<RawNetworkFlowStatus | null | "pending">(
    "pending",
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const [depositPending, setDepositPending] = React.useState(false);
  const [depositError, setDepositError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!isToon || !isSelf) {
      setRaw(null);
      return;
    }
    setRefreshing(true);
    try {
      const status =
        (await getActiveToonTransport()
          ?.getPaidWriter()
          .getNetworkFlowStatus()) ?? null;
      setRaw(status);
    } catch (error) {
      console.error("[network-spend] refresh failed", error);
      setRaw(null);
    } finally {
      setRefreshing(false);
    }
  }, [isToon, isSelf]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const deposit = React.useCallback(
    async (amountBaseUnits: bigint): Promise<boolean> => {
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
    [refresh],
  );

  const state: NetworkSpendState = deriveNetworkSpendState({
    isToon,
    isSelf,
    raw,
    live,
  });

  return {
    state,
    refresh,
    refreshing,
    deposit,
    canDeposit: canRefillNetworkSpend(state),
    depositPending,
    depositError,
  };
}
