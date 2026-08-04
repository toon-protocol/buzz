/**
 * Provisioning-step derivation for a managed agent's TOON wallet (buzz#74).
 *
 * Mirrors `toonOnboardingState.ts`'s ADR directly: the current step must be
 * derived from what is actually true of the agent's own derived address —
 * key assigned, funded, channel open — not replayed from a stored counter,
 * so quitting mid-flow and coming back resumes from reality rather than
 * stranding the operator on a step already finished (or re-running one that
 * was not).
 *
 * `accountIndex` and the two balances are reality-derived with no flag at
 * all (a Rust registry read and two free RPC balance reads). `channelConfirmed`
 * is a persisted flag set only once this flow's own channel-open action
 * succeeds — same tradeoff the onboarding wizard already makes for its own
 * channel step, and for the same reason: there is no free on-chain probe for
 * "does this address already have a channel with this destination" to check
 * instead.
 */

/** One position in the flow. `"done"` means every step cleared. */
export type AgentProvisioningStepId = "key" | "fund" | "channel" | "done";

/** Everything the derivation needs, gathered by the caller. */
export type AgentProvisioningSnapshot = {
  /**
   * The agent's BIP-44 account index, assigned by `create_managed_agent`
   * (buzz#79) — null while that read has not resolved yet, never treated as
   * "assign one now" (this module never assigns, only reads).
   */
  accountIndex: number | null;
  /**
   * The agent's own derived-address settlement-token balance, base units, or
   * null when not yet read (never treated as zero).
   */
  usdcBaseUnits: bigint | null;
  /** The agent's own derived-address native-gas balance, base units, or null when not yet read. */
  nativeBaseUnits: bigint | null;
  /** This flow's own channel-open action has succeeded (persisted flag). */
  channelConfirmed: boolean;
};

export type AgentProvisioningStatus = {
  step: AgentProvisioningStepId;
  /** The settlement token has landed on the agent's address. */
  fundedForToken: boolean;
  /** Native gas has landed — required before the agent's channel-open transaction. */
  hasNativeGas: boolean;
  /**
   * The token arrived but gas did not. `sendTransfer`'s two legs (buzz#74)
   * are independent calls, so one can fail while the other lands — this is
   * an expected steady state to surface for manual retry, not a crash.
   */
  needsManualGasTopUp: boolean;
};

function isPositive(amount: bigint | null): boolean {
  return amount !== null && amount > 0n;
}

/**
 * Derive the flow's current step and the fund step's sub-state from a
 * snapshot of reality. No side effects, no I/O — everything it needs has
 * already been read by the caller.
 */
export function deriveAgentProvisioningStatus(
  snapshot: AgentProvisioningSnapshot,
): AgentProvisioningStatus {
  const fundedForToken = isPositive(snapshot.usdcBaseUnits);
  const hasNativeGas = isPositive(snapshot.nativeBaseUnits);
  const needsManualGasTopUp = fundedForToken && !hasNativeGas;

  let step: AgentProvisioningStepId;
  if (snapshot.accountIndex === null) {
    step = "key";
  } else if (!fundedForToken || !hasNativeGas) {
    step = "fund";
  } else if (!snapshot.channelConfirmed) {
    step = "channel";
  } else {
    step = "done";
  }

  return { step, fundedForToken, hasNativeGas, needsManualGasTopUp };
}

/** 1-based position for `StepProgress`, `"done"` clamped to the last step. */
export const AGENT_PROVISIONING_STEP_ORDER: AgentProvisioningStepId[] = [
  "key",
  "fund",
  "channel",
];

export function agentProvisioningStepNumber(
  step: AgentProvisioningStepId,
): number {
  const index = AGENT_PROVISIONING_STEP_ORDER.indexOf(step);
  return index === -1 ? AGENT_PROVISIONING_STEP_ORDER.length : index + 1;
}
