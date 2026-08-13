import type { HuddleFeeQuote } from "./huddleFeeQuote";

/**
 * Mid-huddle low-collateral warning (buzz#68).
 *
 * #67's `huddleFeeQuote.ts` quotes a per-minute *ceiling* rate before you
 * join; this module turns that same ceiling plus the live channel balance
 * into "how much longer can I keep speaking" — a conservative floor (the
 * ceiling rate, not the average) so the warning fires before, not after,
 * frames start getting refused (F03) and the speaker goes silent mid-word.
 */

/** Below this many seconds of estimated speech remaining, the huddle bar warns. */
export const HUDDLE_LOW_COLLATERAL_SECONDS = 60;

/** What the huddle bar knows about how much longer speaking can continue. */
export type HuddleCollateralStatus =
  /** No fee quote, no balance, or a free (zero-cost) route — nothing to warn about. */
  | { kind: "unknown" }
  /** Estimated speech time remaining is above the warning threshold. */
  | { kind: "sufficient"; remainingSeconds: number }
  /** Estimated speech time remaining has dropped below the warning threshold. */
  | { kind: "low"; remainingSeconds: number };

/**
 * Derive collateral status from the huddle fee quote and the live channel
 * balance. Never throws; a quote that isn't `quoted` or a balance that isn't
 * known both read as `unknown` rather than guessing.
 */
export function deriveHuddleCollateralStatus(
  quote: HuddleFeeQuote,
  remainingBaseUnits: bigint | null,
): HuddleCollateralStatus {
  if (quote.kind !== "quoted") return { kind: "unknown" };
  if (remainingBaseUnits === null) return { kind: "unknown" };
  if (quote.perMinuteCeilingBaseUnits <= 0n) return { kind: "unknown" };

  const remainingSeconds =
    (Number(remainingBaseUnits) / Number(quote.perMinuteCeilingBaseUnits)) *
    60;

  return remainingSeconds < HUDDLE_LOW_COLLATERAL_SECONDS
    ? { kind: "low", remainingSeconds }
    : { kind: "sufficient", remainingSeconds };
}

/** Render seconds as the huddle bar's compact remaining-time phrase. */
export function formatRemainingSpeechTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped < 60) return `${Math.round(clamped)}s`;

  const minutes = clamped / 60;
  if (minutes < 60) return `${Math.round(minutes)} min`;

  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} hr`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The caption the huddle bar shows for `status`, or null when there is
 * nothing to say — sufficient runway is quiet by design (the issue's own
 * follow-up notes devnet pricing buys ~55 hours; a persistent caption for
 * that case would be noise, not a warning).
 */
export function huddleCollateralCaption(
  status: HuddleCollateralStatus,
): string | null {
  switch (status.kind) {
    case "unknown":
    case "sufficient":
      return null;
    case "low":
      return `Low balance — about ${formatRemainingSpeechTime(
        status.remainingSeconds,
      )} of speaking time left at the current rate. Add funds to keep talking.`;
  }
}
