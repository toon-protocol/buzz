import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SELL_PRICE_MICRO_USDC,
  parseMaxOutputTokensInput,
  SELL_PRICE_UNIT,
  typicalJobCostBaseUnits,
  typicalJobCostCaption,
} from "./meshComputeSellPricing.ts";

// ── wire-format unit ─────────────────────────────────────────────────────
// toon-meta#266 §3.5 recommends the `price` tag's unit be "1k-output-tokens"
// (no protocol floor). buzz#165 implements the recommendation rather than
// inventing a competing unit.

test("SELL_PRICE_UNIT matches the kind:31990 price tag's recommended unit", () => {
  assert.equal(SELL_PRICE_UNIT, "1k-output-tokens");
});

test("defaults are positive and usable without operator input", () => {
  assert.ok(DEFAULT_SELL_PRICE_MICRO_USDC > 0n);
  assert.ok(DEFAULT_MAX_OUTPUT_TOKENS > 0);
});

// ── typicalJobCostBaseUnits ──────────────────────────────────────────────

test("typicalJobCostBaseUnits scales price by output tokens over 1000", () => {
  // 2,000 micro-USDC per 1k output tokens, a 2,048-token ceiling.
  assert.equal(typicalJobCostBaseUnits(2_000n, 2048), 4_096n);
});

test("typicalJobCostBaseUnits floors sub-micro-USDC remainders", () => {
  assert.equal(typicalJobCostBaseUnits(1n, 500), 0n);
});

test("typicalJobCostBaseUnits is zero for a non-positive ceiling", () => {
  assert.equal(typicalJobCostBaseUnits(2_000n, 0), 0n);
  assert.equal(typicalJobCostBaseUnits(2_000n, -5), 0n);
});

// ── typicalJobCostCaption ────────────────────────────────────────────────

test("typicalJobCostCaption names the token ceiling and the computed cost", () => {
  const caption = typicalJobCostCaption(4_096n, 2048);
  assert.match(caption, /2,048/);
  assert.match(caption, /USDC/);
});

// ── parseMaxOutputTokensInput ────────────────────────────────────────────

test("parseMaxOutputTokensInput accepts a positive integer", () => {
  assert.equal(parseMaxOutputTokensInput("2048"), 2048);
  assert.equal(parseMaxOutputTokensInput("1"), 1);
});

test("parseMaxOutputTokensInput rejects zero, negatives, decimals, and junk", () => {
  assert.equal(parseMaxOutputTokensInput("0"), null);
  assert.equal(parseMaxOutputTokensInput("-1"), null);
  assert.equal(parseMaxOutputTokensInput("2048.5"), null);
  assert.equal(parseMaxOutputTokensInput("abc"), null);
  assert.equal(parseMaxOutputTokensInput(""), null);
  assert.equal(parseMaxOutputTokensInput("  "), null);
});

test("parseMaxOutputTokensInput tolerates surrounding whitespace", () => {
  assert.equal(parseMaxOutputTokensInput(" 4096 "), 4096);
});
