import * as React from "react";

import {
  decideRefill,
  deriveRefillAmountBaseUnits,
} from "@/features/agents/lib/agentAutoRefillPolicy";
import {
  getAutoRefillConfig,
  getRemainingCeilingBaseUnits,
  recordConfirmedRefillBaseUnits,
} from "@/features/agents/lib/agentAutoRefillStore";
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import { useIdentityQuery } from "@/shared/api/hooks";

/** How often the policy re-evaluates between network-spend refreshes. */
const POLICY_TICK_MS = 15_000;

/**
 * buzz#132 policy loop: watches this desktop process's own network spend and
 * fires an auto-refill deposit when the operator has opted in, runway has
 * crossed the same warning threshold `SidebarLowFundsCard` alerts on, and the
 * monthly ceiling has room. Mirrors `useAutoRestartPolicy.ts`'s shape.
 *
 * All decision logic lives in `decideRefill` (pure, exhaustively tested).
 * This hook only wires inputs, tracks the in-flight dedupe gate, and calls
 * the existing `useNetworkSpend` deposit action.
 *
 * Deposits only ever land on `getActiveToonTransport()`'s own writer — the
 * identity this desktop process itself pays as (`useNetworkSpend.ts`'s
 * documented constraint) — so this loop evaluates only the current identity,
 * not the whole managed-agent fleet.
 */
export function useAgentAutoRefillPolicy(): void {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const network = useNetworkSpend(currentPubkey ?? "", true);
  const inFlightRef = React.useRef(false);
  const [, setTick] = React.useState(0);

  // Re-evaluate on an interval. Each tick re-reads agentAutoRefillStore.ts's
  // config/ledger (so the Money tab's opt-in toggle is noticed within one
  // tick without a store subscription) AND refreshes the network read:
  // `useNetworkSpend` fetches its claim-state read once at mount and again
  // only after this hook's own deposit — every `refresh` dependency is
  // referentially stable — so without an explicit refresh here a steadily
  // draining channel would keep its mount-time runway forever and the policy
  // could never fire. Refresh through a ref (the callback identity changes
  // across renders) and only while opted in, so sessions that never enabled
  // auto-refill add no recurring connector traffic.
  const refreshRef = React.useRef(network.refresh);
  refreshRef.current = network.refresh;

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (currentPubkey && getAutoRefillConfig(currentPubkey).enabled) {
        void refreshRef.current();
      }
      setTick((t) => t + 1);
    }, POLICY_TICK_MS);
    return () => clearInterval(timer);
  }, [currentPubkey]);

  // No dependency array by design (matches useAutoRestartPolicy.ts): the tick
  // pattern re-runs this effect every render so it reads live store state;
  // all mutation is ref-local.
  React.useEffect(() => {
    if (!currentPubkey) return;

    const state = network.state;
    const config = getAutoRefillConfig(currentPubkey);
    // `null` means "not opted in", which `decideRefill` already holds on.
    const remainingCeiling = getRemainingCeilingBaseUnits(currentPubkey) ?? 0n;

    const decision = decideRefill({
      optedIn: config.enabled,
      state,
      remainingCeilingBaseUnits: remainingCeiling,
      refillInFlight: inFlightRef.current,
    });
    if (decision !== "fire") return;
    // `decideRefill` only returns "fire" once `kind === "quoted"` held; this
    // re-check is what narrows `state` for the amount derivation below.
    if (state.kind !== "quoted") return;

    const amount = deriveRefillAmountBaseUnits({
      burnRateBaseUnitsPerSec: state.read.burnRateBaseUnitsPerSec,
      remainingCeilingBaseUnits: remainingCeiling,
    });
    if (amount <= 0n) return;

    inFlightRef.current = true;
    void network
      .deposit(amount)
      .then((succeeded) => {
        // Increment only on confirmed deposit — never on intent, or a failed
        // deposit would permanently eat ceiling.
        if (succeeded) recordConfirmedRefillBaseUnits(currentPubkey, amount);
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  });
}
