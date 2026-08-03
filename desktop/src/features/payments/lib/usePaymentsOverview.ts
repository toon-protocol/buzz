import * as React from "react";

import { deriveWalletAddress } from "@/features/onboarding/toon/toonOnboardingIdentity";
import { readToonOnboardingBalances } from "@/features/onboarding/toon/toonOnboardingBalances";
import {
  getStoredMnemonic,
  subscribeToToonOnboardingState,
} from "@/features/onboarding/toon/toonOnboardingStore";
import type { ToonOnboardingBalanceState } from "@/features/onboarding/toon/useToonOnboarding";
import {
  getActiveToonTransport,
  getActiveTransportSelection,
} from "@/shared/api/transportSelection";
import {
  deriveChannelState,
  derivePaymentsCardState,
  type PaymentsCardState,
} from "@/features/payments/lib/paymentsOverview";

/**
 * Wires `paymentsOverview.ts`'s pure derivation to the network reads and
 * actions the Settings -> Payments card needs (buzz#77).
 *
 * Follows `useToonOnboarding`'s shape: every network step is explicit and
 * re-triggerable via `refresh`, rather than a background poll — a card a
 * user glances at and leaves must not spend the connector's attention (or
 * the owner's gas) on its own.
 */

const EMPTY_BALANCES: ToonOnboardingBalanceState = {
  tokenBaseUnits: null,
  nativeBaseUnits: null,
  checked: false,
  unreadable: false,
};

export function usePaymentsOverview() {
  const selection = getActiveTransportSelection();
  const isToon = selection?.mode === "toon";
  const config = selection?.config ?? null;

  const mnemonic = React.useSyncExternalStore(
    subscribeToToonOnboardingState,
    getStoredMnemonic,
  );

  const [address, setAddress] = React.useState<string | null>(null);
  const [balances, setBalances] =
    React.useState<ToonOnboardingBalanceState>(EMPTY_BALANCES);
  const [channel, setChannel] = React.useState<ReturnType<
    typeof deriveChannelState
  > | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionPending, setActionPending] = React.useState(false);

  React.useEffect(() => {
    if (!mnemonic) {
      setAddress(null);
      return;
    }
    let cancelled = false;
    deriveWalletAddress(mnemonic)
      .then((derived) => {
        if (!cancelled) setAddress(derived);
      })
      .catch((error: unknown) => {
        console.error("[payments] could not derive the owner address", error);
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

  const refresh = React.useCallback(async () => {
    if (!isToon || !config || !address) return;
    setRefreshing(true);
    try {
      const [balanceResult, channelStatus] = await Promise.all([
        readToonOnboardingBalances(config, address),
        getActiveToonTransport()?.getPaidWriter().getChannelStatus() ??
          Promise.resolve(null),
      ]);
      setBalances({
        tokenBaseUnits: balanceResult.tokenBaseUnits,
        nativeBaseUnits: balanceResult.nativeBaseUnits,
        checked: true,
        unreadable: balanceResult.unreadable,
      });
      setChannel(deriveChannelState(channelStatus));
    } catch (error) {
      console.error("[payments] overview refresh failed", error);
      setBalances((prev) => ({ ...prev, checked: true, unreadable: true }));
      setChannel(deriveChannelState(null));
    } finally {
      setRefreshing(false);
    }
  }, [isToon, config, address]);

  React.useEffect(() => {
    if (address) void refresh();
  }, [address, refresh]);

  const runAction = React.useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(null);
      setActionPending(true);
      try {
        await action();
        await refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setActionPending(false);
      }
    },
    [refresh],
  );

  const deposit = React.useCallback(
    (amountBaseUnits: bigint) =>
      runAction(async () => {
        const writer = getActiveToonTransport()?.getPaidWriter();
        if (!writer) throw new Error("No TOON transport is active.");
        await writer.depositToChannel(amountBaseUnits);
      }),
    [runAction],
  );

  const closeChannel = React.useCallback(
    () =>
      runAction(async () => {
        const writer = getActiveToonTransport()?.getPaidWriter();
        if (!writer) throw new Error("No TOON transport is active.");
        await writer.closeChannel();
      }),
    [runAction],
  );

  const settleChannel = React.useCallback(
    () =>
      runAction(async () => {
        const writer = getActiveToonTransport()?.getPaidWriter();
        if (!writer) throw new Error("No TOON transport is active.");
        await writer.settleChannel();
      }),
    [runAction],
  );

  const cardState: PaymentsCardState = derivePaymentsCardState({
    isToon,
    mnemonic,
    address,
    balances,
    channel,
  });

  return {
    state: cardState,
    refresh,
    refreshing,
    deposit,
    closeChannel,
    settleChannel,
    actionPending,
    actionError,
  };
}
