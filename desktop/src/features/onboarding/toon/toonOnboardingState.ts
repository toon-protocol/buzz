/**
 * The TOON onboarding wizard's state derivation — pure, no fetch, no timers.
 *
 * The wizard walks a fresh install from nothing to a first paid message:
 * identity → funded → payment channel → first message. Re-entrancy (ADR: the
 * wizard must survive quit/resume at any step) means the CURRENT step has to
 * be derived from what is actually true, not replayed from a step counter —
 * a counter can drift from reality (a reinstalled app with a still-live
 * on-chain channel, a balance that changed outside the wizard), and a stuck
 * counter strands the user on a step they already finished.
 *
 * Two of the four facts below **are** reality-derived and need no flag at
 * all: whether a wallet identity exists, and whether it holds funds — both
 * come straight from a wallet read. The other two — channel-open and
 * first-message-sent — are recorded as flags once the wizard's own consented
 * action succeeds. That is not a step counter in disguise: probing "is a
 * channel already open" without a flag would mean calling the same
 * client-start path the consent gate exists to guard, and there is no
 * equivalent free probe for "has this identity ever published." The flags are
 * safe to lose, though — see `docs: re-entrancy without the flags` below.
 */

/** One position in the wizard. `"done"` is not shown; it means close the gate. */
export type ToonOnboardingStepId =
  | "identity"
  | "fund"
  | "channel"
  | "message"
  | "done";

/** Everything the derivation needs, gathered by the caller. */
export type ToonOnboardingSnapshot = {
  /** A payment mnemonic has been generated or imported and is stored. */
  hasWallet: boolean;
  /**
   * Settlement-token balance in base units, or null when not yet read (never
   * treated as zero — an unread balance must not look like an empty wallet).
   */
  usdcBaseUnits: bigint | null;
  /** Native-gas balance in base units, or null when not yet read. */
  nativeBaseUnits: bigint | null;
  /**
   * The wizard's own channel-open action has succeeded (this session's live
   * writer, or a flag persisted from an earlier one).
   */
  channelConfirmed: boolean;
  /** The wizard's own first-message action has succeeded (persisted flag). */
  firstMessageSent: boolean;
};

export type ToonOnboardingStatus = {
  step: ToonOnboardingStepId;
  /** The settlement token has landed. */
  fundedForToken: boolean;
  /** Native gas has landed — required before a channel-open transaction. */
  hasNativeGas: boolean;
  /**
   * The token arrived but gas did not — the faucet's gas leg is best-effort,
   * so this is an expected steady state, not a failure. The fund step should
   * show manual top-up guidance rather than spin forever.
   */
  needsManualGasTopUp: boolean;
};

function isPositive(amount: bigint | null): boolean {
  return amount !== null && amount > 0n;
}

/**
 * Whether the channel step counts as done, from every source of truth that
 * makes it so (buzz#28): the wizard's own persisted consent flag, a writer
 * that is already live this session, or — new — a channel this session could
 * RESUME with zero new spend. None of the three implies the others (a fresh
 * install has none; a resumed session may have only the third), but any one
 * is enough: nothing new would be spent by treating the step as finished, so
 * there is nothing left to consent to.
 */
export function isChannelStepConfirmed(inputs: {
  channelConfirmedFlag: boolean;
  transportWritable: boolean;
  resumableChannelExists: boolean;
}): boolean {
  return (
    inputs.channelConfirmedFlag ||
    inputs.transportWritable ||
    inputs.resumableChannelExists
  );
}

/**
 * Derive the wizard's current step and the fund step's sub-state from a
 * snapshot of reality. No side effects, no I/O — everything it needs has
 * already been read by the caller.
 */
export function deriveToonOnboardingStatus(
  snapshot: ToonOnboardingSnapshot,
): ToonOnboardingStatus {
  const fundedForToken = isPositive(snapshot.usdcBaseUnits);
  const hasNativeGas = isPositive(snapshot.nativeBaseUnits);
  const needsManualGasTopUp = fundedForToken && !hasNativeGas;

  let step: ToonOnboardingStepId;
  if (!snapshot.hasWallet) {
    step = "identity";
  } else if (!fundedForToken || !hasNativeGas) {
    step = "fund";
  } else if (!snapshot.channelConfirmed) {
    step = "channel";
  } else if (!snapshot.firstMessageSent) {
    step = "message";
  } else {
    step = "done";
  }

  return { step, fundedForToken, hasNativeGas, needsManualGasTopUp };
}

/** 1-based position for `StepProgress`, `"done"` clamped to the last step. */
export const TOON_ONBOARDING_STEP_ORDER: ToonOnboardingStepId[] = [
  "identity",
  "fund",
  "channel",
  "message",
];

export function toonOnboardingStepNumber(step: ToonOnboardingStepId): number {
  const index = TOON_ONBOARDING_STEP_ORDER.indexOf(step);
  return index === -1 ? TOON_ONBOARDING_STEP_ORDER.length : index + 1;
}
