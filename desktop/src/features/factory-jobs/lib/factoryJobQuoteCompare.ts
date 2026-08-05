import type {
  FactoryJobQuote,
  FactoryJobQuoteIncrement,
} from "@/features/factory-jobs/lib/factoryJobFeedback";

/**
 * Comparing RFQ quotes (buzz#85 "What" §2): schedule and per-increment price
 * next to ambient job history and gate-pass rate. Two rules from the issue's
 * gotchas, both load-bearing here:
 *
 * - Gate-pass rate is conformance, not quality — labelled that way everywhere
 *   it is shown, never rendered as a bare percentage that reads as a star
 *   rating.
 * - Cold-start is hostile: a provider with no history has no reputation
 *   score to sort on, and sorting purely by reputation makes new providers
 *   invisible (toon-meta#262's own gotcha list). This module therefore never
 *   produces one reputation-sorted list — it partitions established
 *   providers from cold-start ones so a caller can surface both.
 */

/** Ambient history + gate-pass rate — decision 8's only two reputation signals. Absent entirely = cold-start. */
export type FactoryJobProviderReputation = {
  jobsCompleted: number;
  /** Fraction (0..1) of completed jobs whose increments all gate-passed. `null` when nothing gated has completed yet. */
  gatePassRate: number | null;
};

export type FactoryJobQuoteComparisonRow = {
  eventId: string;
  providerPubkey: string;
  createdAt: number;
  incrementCount: number;
  totalPriceBaseUnits: bigint;
  increments: FactoryJobQuoteIncrement[];
  reputation: FactoryJobProviderReputation | null;
  /** `bid` is a maximum (§2.1) — a quote summing above it is out of the running per the spec's own wording. */
  exceedsBid: boolean;
};

function totalPrice(increments: FactoryJobQuoteIncrement[]): bigint {
  return increments.reduce((sum, entry) => sum + entry.priceUsdcBaseUnits, 0n);
}

function toRow(
  quote: FactoryJobQuote,
  bidBaseUnits: bigint,
  reputationByPubkey: ReadonlyMap<string, FactoryJobProviderReputation>,
): FactoryJobQuoteComparisonRow {
  const total = totalPrice(quote.increments);
  return {
    eventId: quote.eventId,
    providerPubkey: quote.providerPubkey,
    createdAt: quote.createdAt,
    incrementCount: quote.increments.length,
    totalPriceBaseUnits: total,
    increments: quote.increments,
    reputation: reputationByPubkey.get(quote.providerPubkey) ?? null,
    exceedsBid: total > bidBaseUnits,
  };
}

function byPriceThenAge(
  a: FactoryJobQuoteComparisonRow,
  b: FactoryJobQuoteComparisonRow,
): number {
  if (a.totalPriceBaseUnits !== b.totalPriceBaseUnits) {
    return a.totalPriceBaseUnits < b.totalPriceBaseUnits ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

export type FactoryJobQuoteComparison = {
  established: FactoryJobQuoteComparisonRow[];
  /** Deliberately kept separate rather than folded into a reputation-sorted list — see module doc. */
  coldStart: FactoryJobQuoteComparisonRow[];
};

/** Build the two-group comparison a "compare quotes" screen renders. Both groups sorted cheapest-first. */
export function compareFactoryJobQuotes(
  quotes: FactoryJobQuote[],
  bidBaseUnits: bigint,
  reputationByPubkey: ReadonlyMap<string, FactoryJobProviderReputation>,
): FactoryJobQuoteComparison {
  const rows = quotes.map((quote) =>
    toRow(quote, bidBaseUnits, reputationByPubkey),
  );
  const established = rows
    .filter((row) => row.reputation !== null)
    .sort(byPriceThenAge);
  const coldStart = rows
    .filter((row) => row.reputation === null)
    .sort(byPriceThenAge);
  return { established, coldStart };
}

/**
 * The label every gate-pass figure must carry — conformance, not quality
 * (buzz#85 gotcha). `rate` is `null` in two genuinely different cases that
 * must never share copy: nothing has completed yet, versus jobs completed
 * but the wire carries no gate-pass signal for them (`useFactoryJobBuyer.ts`
 * — no ticket has put one on kind:6097 yet). Conflating the two reads as "no
 * completed jobs" next to a nonzero completed-job count, which is false.
 */
export function gatePassRateLabel(
  rate: number | null,
  jobsCompleted: number,
): string {
  if (rate !== null) {
    return `${Math.round(rate * 100)}% gate-pass rate (conformance, not quality)`;
  }
  return jobsCompleted > 0 ? "No gate-pass data" : "No completed jobs yet";
}
