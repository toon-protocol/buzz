import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";

/**
 * The property the whole buyer surface exists to make visible (buzz#85): "you
 * can stop at any increment, having risked at most one." A generic progress
 * bar hides this — this module is the one place that states it plainly, so
 * every surface (job thread, pay confirmation) renders the same sentence
 * instead of each inventing its own.
 *
 * Mirrors the huddle fee quote / payments-card discriminated-union idiom:
 * pure derivation, no I/O, unit-tested without a DOM.
 */

export type FactoryJobExposure = {
  paidCount: number;
  totalCount: number;
  paidAmountBaseUnits: bigint;
  /** The next unpaid increment's price, or `null` once every increment is paid. */
  nextIncrementAmountBaseUnits: bigint | null;
  /** What is still at risk if every remaining increment is paid — never what has already been spent. */
  remainingAmountBaseUnits: bigint;
  isComplete: boolean;
};

/**
 * `paidIncrementNumbers` — the `n` values of increments this buyer has paid
 * for, from `FactoryJobIncrementOffer.increment.n` after a successful
 * `payFactoryJobIncrement`. Amounts come from the quote's own schedule
 * (`FactoryJobQuoteIncrement`), not from the offers themselves, so exposure
 * can be shown before any offer has arrived.
 */
export function deriveFactoryJobExposure(
  schedule: { n: number; priceUsdcBaseUnits: bigint }[],
  paidIncrementNumbers: ReadonlySet<number>,
): FactoryJobExposure {
  const sorted = [...schedule].sort((a, b) => a.n - b.n);
  const totalCount = sorted.length;
  const paidCount = sorted.filter((entry) =>
    paidIncrementNumbers.has(entry.n),
  ).length;

  const paidAmountBaseUnits = sorted
    .filter((entry) => paidIncrementNumbers.has(entry.n))
    .reduce((sum, entry) => sum + entry.priceUsdcBaseUnits, 0n);

  const unpaid = sorted.filter((entry) => !paidIncrementNumbers.has(entry.n));
  const remainingAmountBaseUnits = unpaid.reduce(
    (sum, entry) => sum + entry.priceUsdcBaseUnits,
    0n,
  );

  return {
    paidCount,
    totalCount,
    paidAmountBaseUnits,
    nextIncrementAmountBaseUnits: unpaid[0]?.priceUsdcBaseUnits ?? null,
    remainingAmountBaseUnits,
    isComplete: totalCount > 0 && paidCount === totalCount,
  };
}

/**
 * The reassurance sentence itself. "Paid 3 of 7 increments; stopping now
 * costs nothing further" — the whole product, per the issue's gotcha.
 */
export function factoryJobExposureCaption(
  exposure: FactoryJobExposure,
): string {
  if (exposure.totalCount === 0) {
    return "No increments quoted yet — nothing has been risked.";
  }
  if (exposure.paidCount === 0) {
    return `Paid nothing yet, out of ${exposure.totalCount} quoted increments. Stopping now costs nothing.`;
  }
  if (exposure.isComplete) {
    return `Paid all ${exposure.totalCount} of ${exposure.totalCount} increments (${formatUsdcBaseUnits(exposure.paidAmountBaseUnits)}). The job is complete.`;
  }
  return `Paid ${exposure.paidCount} of ${exposure.totalCount} increments (${formatUsdcBaseUnits(exposure.paidAmountBaseUnits)}); stopping now costs nothing further.`;
}
