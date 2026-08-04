import { KIND_FACTORY_JOB_FEEDBACK } from "@/shared/constants/kinds";

/**
 * Quote (buzz#84 "What" §3): the provider's half of `kind:7000`
 * `status:"quote"`, built to the exact shape `factoryJobFeedback.ts`'s
 * `parseFactoryJobFeedback` already reads on the buyer side (that module
 * documents itself as read-only — "it never... builds a request; kind:7000
 * is always provider-authored" — this is that missing builder).
 *
 * Per decision 7 (toon-meta#262), a quote is the increment schedule and
 * per-increment price, nothing else: **acceptance is payment of increment
 * 1** — there is no separate accept message, so this module has no
 * corresponding "accept" shape to build.
 */

export type FactoryJobQuoteIncrementInput = {
  milestone: string;
  priceUsdcBaseUnits: bigint;
};

export type FactoryJobQuoteTemplate = {
  kind: typeof KIND_FACTORY_JOB_FEEDBACK;
  content: string;
  tags: string[][];
};

/**
 * Build the unsigned `kind:7000` quote template. `n`/`of` are derived from
 * position — the caller supplies milestones in schedule order, never numbers
 * to get wrong or out of sync with the array length.
 */
export function buildFactoryJobQuote(input: {
  /** The `kind:5097` job request this quote answers. */
  rootJobId: string;
  increments: FactoryJobQuoteIncrementInput[];
}): FactoryJobQuoteTemplate {
  if (!input.rootJobId.trim()) {
    throw new Error("A quote needs the job it is answering.");
  }
  if (input.increments.length === 0) {
    throw new Error("A quote needs at least one increment.");
  }
  for (const increment of input.increments) {
    if (!increment.milestone.trim()) {
      throw new Error("Every increment needs a milestone name.");
    }
    if (increment.priceUsdcBaseUnits <= 0n) {
      throw new Error("Every increment's price must be positive.");
    }
  }

  const of = input.increments.length;
  const content = JSON.stringify({
    increments: input.increments.map((increment, index) => ({
      n: index + 1,
      of,
      milestone: increment.milestone.trim(),
      priceUsdc: increment.priceUsdcBaseUnits.toString(),
    })),
  });

  return {
    kind: KIND_FACTORY_JOB_FEEDBACK,
    content,
    tags: [
      ["status", "quote"],
      ["e", input.rootJobId, "", "root"],
    ],
  };
}
