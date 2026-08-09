import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";

/**
 * Seller pricing for the `kind:31990` mesh-compute advertisement (buzz#165,
 * part of toon-protocol/toon-meta#265's mesh-compute epic).
 *
 * The wire shape lives in toon-meta's `docs/mesh-compute-job-protocol.md`
 * §3.1/§3.5: a `price` tag of `["price", "<micro-USDC>", "usdc", "<unit>"]`.
 * §3.5 is a genuine owner judgment call
 * ([toon-meta#317](https://github.com/toon-protocol/toon-meta/issues/317))
 * but is not a blocker — the document's own recommendation is implemented
 * here rather than inventing a competing unit, per buzz#165's own
 * instruction to "implement whatever the spec lands on."
 *
 * NOTE: neither buzz#90 (sell-compute mode) nor buzz#91 (the kind:31990
 * publisher) exist in this codebase yet, so this module only owns the
 * operator-facing number and its preview math — not an actual Nostr
 * publish. See `meshComputeSellPricingStore.ts` for the revision-tracking
 * half of AC2.
 */

/** `docs/mesh-compute-job-protocol.md` §3.5's recommended `price` tag unit. */
export const SELL_PRICE_UNIT = "1k-output-tokens";

/**
 * 2,000 micro-USDC (0.002 USDC) per 1,000 output tokens — roughly $2/M
 * tokens. Above commodity hosted-API pricing (the pitch is sovereignty, not
 * price — epic decision 10), but not so high the default listing never
 * converts. §3.5 recommends no protocol-enforced floor; this is only a
 * starting point the operator can revise immediately.
 */
export const DEFAULT_SELL_PRICE_MICRO_USDC = 2_000n;

/** A representative output ceiling for the "typical job" preview until the seller has set one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * micro-USDC per 1,000 output tokens, at the given output-token ceiling.
 * Floors sub-micro-USDC remainders — the advertised price is a rate, not a
 * guarantee of exact-cent billing.
 */
export function typicalJobCostBaseUnits(
  priceMicroUsdcPer1kTokens: bigint,
  maxOutputTokens: number,
): bigint {
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return 0n;
  return (
    (priceMicroUsdcPer1kTokens * BigInt(Math.trunc(maxOutputTokens))) / 1000n
  );
}

/**
 * "What this means in practice" (AC3): the cost of one full-length job at
 * the seller's current ceiling, in plain USDC — not a micro-USDC-per-unit
 * rate the operator has to do math on.
 */
export function typicalJobCostCaption(
  priceBaseUnits: bigint,
  maxOutputTokens: number,
): string {
  const tokens = maxOutputTokens.toLocaleString();
  return `A full-length job (up to ${tokens} output tokens) costs up to ${formatUsdcBaseUnits(priceBaseUnits)}.`;
}

/**
 * Parse the max-output-tokens ceiling field: a positive integer, nothing
 * else — fractional or zero/negative tokens make no sense as a generation
 * ceiling.
 */
export function parseMaxOutputTokensInput(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : null;
}
