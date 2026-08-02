import assert from "node:assert/strict";
import test from "node:test";

import { composerFeeCaption } from "./composerFeeCaption.ts";

/**
 * Covers buzz#30: the composer's fee caption formats base-unit amounts (the
 * shape every quote arrives in — `ToonPaidWriter.quoteFee`'s return type) as
 * the USDC-scale-6 line the wizard already uses (`toonOnboardingFormat.ts`),
 * and renders nothing at all — not "0.00 USDC", not an empty string — when
 * there is no amount to show.
 */

test("null (relay mode, or a failed quote) renders no caption", () => {
  assert.equal(composerFeeCaption(null), null);
});

test("a sub-cent fee formats with enough precision to be legible", () => {
  // 1_000 base units at USDC's 6-decimal scale = 0.001 USDC.
  assert.equal(composerFeeCaption(1_000n), "0.001 USDC per message");
});

test("a zero-fee route renders a fee line, not nothing", () => {
  // Zero is a real (free) quote, not a failed one — must still be visible.
  assert.equal(composerFeeCaption(0n), "0.00 USDC per message");
});

test("a whole-cent fee formats to two decimal places", () => {
  // 2_500_000 base units = 2.50 USDC.
  assert.equal(composerFeeCaption(2_500_000n), "2.50 USDC per message");
});
