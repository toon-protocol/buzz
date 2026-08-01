import * as React from "react";

import { readToonOnboardingBalances } from "@/features/onboarding/toon/toonOnboardingBalances";
import {
  deriveWalletAddress,
  generateWalletMnemonic,
  isValidWalletMnemonic,
} from "@/features/onboarding/toon/toonOnboardingIdentity";
import {
  deriveToonOnboardingStatus,
  isChannelStepConfirmed,
  type ToonOnboardingStatus,
} from "@/features/onboarding/toon/toonOnboardingState";
import {
  getStoredMnemonic,
  isToonChannelConfirmed,
  isToonFirstMessageSent,
  setStoredMnemonic,
  setToonChannelConfirmed,
  setToonFirstMessageSent,
  subscribeToToonOnboardingState,
} from "@/features/onboarding/toon/toonOnboardingStore";
import {
  requestFaucetDrip,
  type FaucetDripOutcome,
} from "@/features/onboarding/toon/toonFaucetClient";
import { sendStreamMessage } from "@/shared/api/eventWrites";
import {
  getActiveToonTransport,
  getActiveTransportSelection,
} from "@/shared/api/transportSelection";
import { hasPersistedChannel } from "@/shared/api/toonChannelResumeStore";

/**
 * Wires the pure step-derivation (`toonOnboardingState.ts`) and the stored
 * wizard identity (`toonOnboardingStore.ts`) to the network calls the wizard
 * screen needs a step at a time: derive an address, drip the faucet, read a
 * balance, open a channel, quote and send the first message.
 *
 * Deliberately un-clever about polling: every network step is a button press
 * that resolves to a result the UI renders, not a background loop. A wizard a
 * user can walk away from mid-poll and come back to later is worth more than
 * one that refreshes itself while they are not looking, and re-entrancy
 * already covers the "came back later" case from outside this hook.
 */

const BALANCE_POLL_ATTEMPTS = 5;
const BALANCE_POLL_INTERVAL_MS = 3_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reactive snapshot of the wizard's persisted identity + progress flags. */
function useStoredWizardState() {
  const subscribe = subscribeToToonOnboardingState;
  const mnemonic = React.useSyncExternalStore(subscribe, getStoredMnemonic);
  const channelConfirmed = React.useSyncExternalStore(
    subscribe,
    isToonChannelConfirmed,
  );
  const firstMessageSent = React.useSyncExternalStore(
    subscribe,
    isToonFirstMessageSent,
  );
  return { mnemonic, channelConfirmed, firstMessageSent };
}

export type ToonOnboardingBalanceState = {
  tokenBaseUnits: bigint | null;
  nativeBaseUnits: bigint | null;
  /** True once at least one read has completed (success or failure). */
  checked: boolean;
  unreadable: boolean;
};

export function useToonOnboarding() {
  const selection = getActiveTransportSelection();
  const active = selection?.mode === "toon";
  const config = selection?.config ?? null;

  const { mnemonic, channelConfirmed, firstMessageSent } =
    useStoredWizardState();

  const [address, setAddress] = React.useState<string | null>(null);
  const [balances, setBalances] = React.useState<ToonOnboardingBalanceState>({
    tokenBaseUnits: null,
    nativeBaseUnits: null,
    checked: false,
    unreadable: false,
  });
  const [balancesLoading, setBalancesLoading] = React.useState(false);
  const [faucetOutcome, setFaucetOutcome] =
    React.useState<FaucetDripOutcome | null>(null);
  const [faucetLoading, setFaucetLoading] = React.useState(false);
  const [channelLoading, setChannelLoading] = React.useState(false);
  const [channelError, setChannelError] = React.useState<string | null>(null);
  const [messageFee, setMessageFee] = React.useState<bigint | null>(null);
  const [feeError, setFeeError] = React.useState<string | null>(null);
  const [sendLoading, setSendLoading] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  // Derive the address whenever the stored mnemonic changes — pure, local,
  // offline, so there is no reason to gate this behind a button.
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
        console.error("[toon-onboarding] could not derive the address", error);
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

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
      console.error("[toon-onboarding] balance read failed", error);
      setBalances((prev) => ({ ...prev, checked: true, unreadable: true }));
    } finally {
      setBalancesLoading(false);
    }
  }, [config, address]);

  // One read as soon as there is an address to read, so the fund step opens
  // already knowing whether a previous session already funded this wallet.
  React.useEffect(() => {
    if (address) void readBalances();
  }, [address, readBalances]);

  const status: ToonOnboardingStatus = deriveToonOnboardingStatus({
    hasWallet: mnemonic !== null,
    usdcBaseUnits: balances.tokenBaseUnits,
    nativeBaseUnits: balances.nativeBaseUnits,
    channelConfirmed: isChannelStepConfirmed({
      channelConfirmedFlag: channelConfirmed,
      transportWritable: getActiveToonTransport()?.isWritable() ?? false,
      // buzz#28: a channel persisted from an earlier launch is resumable with
      // zero new spend, so it counts as "open" even before this session's
      // writer has started (which only happens lazily, on the first quote or
      // publish, or when this step's own button is pressed).
      resumableChannelExists: config
        ? hasPersistedChannel(config.destination, config.chain)
        : false,
    }),
    firstMessageSent,
  });

  const createIdentity = React.useCallback(async () => {
    const generated = await generateWalletMnemonic();
    setStoredMnemonic(generated);
    getActiveToonTransport()?.setMnemonic(generated);
    return generated;
  }, []);

  const importIdentity = React.useCallback(async (phrase: string) => {
    const trimmed = phrase.trim();
    if (!(await isValidWalletMnemonic(trimmed))) {
      throw new Error(
        "That doesn't look like a valid recovery phrase (expected 12 or 24 BIP-39 words).",
      );
    }
    setStoredMnemonic(trimmed);
    getActiveToonTransport()?.setMnemonic(trimmed);
  }, []);

  const requestFunds = React.useCallback(async () => {
    if (!config || !address) return;
    setFaucetLoading(true);
    setFaucetOutcome(null);
    try {
      const outcome = await requestFaucetDrip({
        faucetUrl: config.faucetUrl,
        address,
      });
      setFaucetOutcome(outcome);
      if (outcome.status === "ok") {
        // The drip is an on-chain mint/transfer, not instant from the
        // requester's point of view — poll a few times rather than reporting
        // "still empty" off a single read that just beat the confirmation.
        for (let attempt = 0; attempt < BALANCE_POLL_ATTEMPTS; attempt += 1) {
          await wait(BALANCE_POLL_INTERVAL_MS);
          await readBalances();
        }
      }
    } finally {
      setFaucetLoading(false);
    }
  }, [config, address, readBalances]);

  const openChannel = React.useCallback(async () => {
    const transport = getActiveToonTransport();
    if (!transport) return;
    setChannelLoading(true);
    setChannelError(null);
    try {
      await transport.ready();
      setToonChannelConfirmed(true);
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelLoading(false);
    }
  }, []);

  const quoteMessageFee = React.useCallback(async () => {
    const transport = getActiveToonTransport();
    if (!transport) return;
    setFeeError(null);
    try {
      const fee = await transport.quoteFee();
      setMessageFee(fee);
    } catch (error) {
      setFeeError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const sendFirstMessage = React.useCallback(
    async (channelId: string, content: string) => {
      setSendLoading(true);
      setSendError(null);
      try {
        await sendStreamMessage(channelId, content);
        setToonFirstMessageSent(true);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        setSendLoading(false);
      }
    },
    [],
  );

  return {
    active,
    config,
    status,
    address,
    balances,
    balancesLoading,
    refreshBalances: readBalances,
    createIdentity,
    importIdentity,
    requestFunds,
    faucetOutcome,
    faucetLoading,
    openChannel,
    channelLoading,
    channelError,
    quoteMessageFee,
    messageFee,
    feeError,
    sendFirstMessage,
    sendLoading,
    sendError,
  };
}
