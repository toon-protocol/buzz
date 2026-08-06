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

  // Re-evaluate on an interval so a runway that degrades between network
  // refreshes still gets picked up promptly. This also re-reads
  // agentAutoRefillStore.ts's config/ledger on every tick, so a change made
  // elsewhere (the Money tab's opt-in toggle) is noticed within one tick
  // without this hook needing its own store subscription.
  React.useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), POLICY_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // No dependency array by design (matches useAutoRestartPolicy.ts): the tick
  // pattern re-runs this effect every render so it reads live store state;
  // all mutation is ref-local.
  React.useEffect(() => {
    if (!currentPubkey) return;
    if (inFlightRef.current) return;

    const config = getAutoRefillConfig(currentPubkey);
    const remainingCeiling = getRemainingCeilingBaseUnits(currentPubkey) ?? 0n;

    const decision = decideRefill({
      optedIn: config.enabled,
      state: network.state,
      remainingCeilingBaseUnits: remainingCeiling,
      refillInFlight: inFlightRef.current,
    });
    if (decision !== "fire") return;
    // Narrows `network.state` for the amount derivation below; `decideRefill`
    // only returns "fire" once `state.kind === "quoted"` already held.
    if (network.state.kind !== "quoted") return;

    const amount = deriveRefillAmountBaseUnits({
      burnRateBaseUnitsPerSec: network.state.read.burnRateBaseUnitsPerSec,
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
