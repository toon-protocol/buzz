import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";

/**
 * The everyday composer's per-message fee caption (buzz#30), or null when
 * nothing should be shown.
 *
 * Reuses the onboarding wizard's `formatUsdcBaseUnits` (`toonOnboardingFormat.ts`)
 * rather than growing a second USDC formatter — the fee should read
 * identically whether it is the wizard's one-time quote or the composer's
 * everyday one. `null` covers both "not TOON mode" and "quote failed": the
 * caller (`useComposerFeeQuote`) collapses both into the same "show nothing"
 * value, since the composer never distinguishes the two in its UI.
 */
export function composerFeeCaption(feeBaseUnits: bigint | null): string | null {
  if (feeBaseUnits === null) return null;
  return `${formatUsdcBaseUnits(feeBaseUnits)} per message`;
}
