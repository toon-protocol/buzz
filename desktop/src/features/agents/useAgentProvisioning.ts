import * as React from "react";

import { readToonOnboardingBalances } from "@/features/onboarding/toon/toonOnboardingBalances";
import { getStoredMnemonic } from "@/features/onboarding/toon/toonOnboardingStore";
import { getManagedAgentAccountIndex } from "@/shared/api/tauriAgentProvisioning";
import { getActiveTransportSelection } from "@/shared/api/transportSelection";
import {
  DEFAULT_AGENT_NATIVE_GAS_BASE_UNITS,
  deriveInitialAllowanceBaseUnits,
} from "./lib/agentProvisioningAllowance";
import {
  deriveAgentProvisioningStatus,
  type AgentProvisioningStatus,
} from "./lib/agentProvisioningState";
import {
  isAgentChannelConfirmed,
  setAgentChannelConfirmed,
  subscribeToAgentProvisioningState,
} from "./lib/agentProvisioningStore";
import {
  buildAgentProvisioningClient,
  buildOwnerProvisioningClient,
  deriveAgentAddress,
  fundAgentWallet,
  openAgentChannel,
} from "./lib/provisionAgent";

/**
 * Wires the pure step-derivation (`agentProvisioningState.ts`) to the
 * network calls buzz#74's provisioning flow needs a step at a time: derive
 * the agent's address from the owner's mnemonic, fund it, open its channel.
 *
 * Mirrors `useToonOnboarding.ts`'s shape and its "deliberately un-clever
 * about polling" stance — every network step is a button press the caller UI
 * drives, not a background loop, and the flow reads its own progress from
 * live state on mount, so quitting mid-flow and reopening resumes correctly.
 */

export type AgentProvisioningBalanceState = {
  tokenBaseUnits: bigint | null;
  nativeBaseUnits: bigint | null;
  /** True once at least one read has completed (success or failure). */
  checked: boolean;
  unreadable: boolean;
};

export function useAgentProvisioning(pubkey: string) {
  const selection = getActiveTransportSelection();
  const active = selection?.mode === "toon";
  const config = selection?.config ?? null;
  const ownerMnemonic = config?.mnemonic ?? getStoredMnemonic();

  const [accountIndex, setAccountIndex] = React.useState<number | null>(null);
  const [address, setAddress] = React.useState<string | null>(null);
  const [balances, setBalances] = React.useState<AgentProvisioningBalanceState>(
    {
      tokenBaseUnits: null,
      nativeBaseUnits: null,
      checked: false,
      unreadable: false,
    },
  );
  const [balancesLoading, setBalancesLoading] = React.useState(false);
  const [fundLoading, setFundLoading] = React.useState(false);
  const [fundError, setFundError] = React.useState<string | null>(null);
  const [channelLoading, setChannelLoading] = React.useState(false);
  const [channelError, setChannelError] = React.useState<string | null>(null);

  const channelConfirmed = React.useSyncExternalStore(
    subscribeToAgentProvisioningState,
    () => isAgentChannelConfirmed(pubkey),
  );

  // Resolve the account index once — `create_managed_agent` already assigns
  // it synchronously at creation (buzz#79), so this is a read, not a wait.
  // Skipped for an empty pubkey (no agent selected yet — `AgentProvisioningDialog`
  // stays mounted with `agent: null` between creations).
  React.useEffect(() => {
    if (!pubkey) {
      setAccountIndex(null);
      return;
    }
    let cancelled = false;
    getManagedAgentAccountIndex(pubkey)
      .then((index) => {
        if (!cancelled) setAccountIndex(index);
      })
      .catch((error: unknown) => {
        console.error(
          "[agent-provisioning] could not read the account index",
          error,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  // Derive the address whenever the owner mnemonic or index resolve — pure,
  // local, offline, so there is no reason to gate this behind a button.
  React.useEffect(() => {
    if (!ownerMnemonic || accountIndex === null) {
      setAddress(null);
      return;
    }
    let cancelled = false;
    deriveAgentAddress(ownerMnemonic, accountIndex)
      .then((derived) => {
        if (!cancelled) setAddress(derived);
      })
      .catch((error: unknown) => {
        console.error(
          "[agent-provisioning] could not derive the agent's address",
          error,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [ownerMnemonic, accountIndex]);

  const readBalances = React.useCallback(async () => {
    if (!config || !address) return;
    setBalancesLoading(true);
    try {
      const result = await readToonOnboardingBalances(config, address);
      setBalances({
        tokenBaseUnits: result.tokenBaseUnits,
        nativeBaseUnits: result.nativeBaseUnits,
        checked: true,
        unreadable: result.unreadable,
      });
    } catch (error) {
      console.error("[agent-provisioning] balance read failed", error);
      setBalances((prev) => ({ ...prev, checked: true, unreadable: true }));
    } finally {
      setBalancesLoading(false);
    }
  }, [config, address]);

  // One read as soon as there is an address to read, so the fund step opens
  // already knowing whether an earlier attempt already funded this address.
  React.useEffect(() => {
    if (address) void readBalances();
  }, [address, readBalances]);

  const status: AgentProvisioningStatus = deriveAgentProvisioningStatus({
    accountIndex,
    usdcBaseUnits: balances.tokenBaseUnits,
    nativeBaseUnits: balances.nativeBaseUnits,
    channelConfirmed,
  });

  /**
   * Fund the agent's address with native gas and settlement token from the
   * owner's own wallet. `sendTransfer` (toon-client#491) already confirms
   * delivery by an observed balance delta before resolving, so a single
   * re-read afterward is enough — no polling loop needed.
   */
  const fund = React.useCallback(async () => {
    if (!config || !address) return;
    setFundLoading(true);
    setFundError(null);
    try {
      const ownerClient = await buildOwnerProvisioningClient(config);
      try {
        const quotedPrice =
          (await ownerClient.getRoutePrice?.(config.destination)) ?? null;
        const tokenAmount = deriveInitialAllowanceBaseUnits({
          measuredBurnRateBaseUnitsPerSec: null,
          quotedWritePriceBaseUnits: quotedPrice,
        });
        const result = await fundAgentWallet({
          ownerClient,
          agentAddress: address,
          chain: "evm",
          nativeAmountBaseUnits: DEFAULT_AGENT_NATIVE_GAS_BASE_UNITS,
          tokenAmountBaseUnits: tokenAmount,
        });
        const failures = [result.native, result.token].filter(
          (leg) => leg.status === "error",
        );
        if (failures.length > 0) {
          setFundError(
            failures
              .map((leg) => (leg.status === "error" ? leg.message : ""))
              .join(" / "),
          );
        }
      } finally {
        await ownerClient.stop();
      }
    } catch (error) {
      setFundError(error instanceof Error ? error.message : String(error));
    } finally {
      setFundLoading(false);
    }
    await readBalances();
  }, [config, address, readBalances]);

  /**
   * Open the agent's own channel, collateralized with whatever landed in
   * the fund step — the actual balance on hand, not a fresh estimate, so
   * this is correct even resumed in a later session with no memory of what
   * the fund step originally computed.
   */
  const openChannel = React.useCallback(async () => {
    if (!config || accountIndex === null || balances.tokenBaseUnits === null)
      return;
    setChannelLoading(true);
    setChannelError(null);
    try {
      const agentClient = await buildAgentProvisioningClient(
        config,
        accountIndex,
        balances.tokenBaseUnits,
      );
      await openAgentChannel({
        agentClient,
        destination: config.destination,
      });
      setAgentChannelConfirmed(pubkey, true);
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelLoading(false);
    }
  }, [config, accountIndex, balances.tokenBaseUnits, pubkey]);

  return {
    active,
    config,
    status,
    address,
    balances,
    balancesLoading,
    refreshBalances: readBalances,
    fund,
    fundLoading,
    fundError,
    openChannel,
    channelLoading,
    channelError,
  };
}
