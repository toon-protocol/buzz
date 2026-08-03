import assert from "node:assert/strict";
import test from "node:test";

import {
  HUDDLE_FRAMES_PER_MINUTE,
  huddleCostCaption,
  joinGatedOnQuote,
  quoteHuddleFee,
} from "./huddleFeeQuote.ts";

/**
 * Covers the buzz#23 stage-3 cost surface: the per-minute ceiling estimate
 * shown BEFORE joining a huddle (acceptance criterion 4a), its VAD caveat,
 * and the join gating rule. Pure-function tests in the `useComposerFeeQuote`
 * mold — no DOM, a mocked `quoteFee` is enough.
 */

test("the ceiling is 50 fps of paid frames for a full minute", () => {
  // One frame per 20 ms — the huddle wire cadence. If this constant drifts,
  // the shown estimate silently stops being a ceiling.
  assert.equal(HUDDLE_FRAMES_PER_MINUTE, 3000n);
});

test("relay mode has no cost to surface", async () => {
  const quote = await quoteHuddleFee(null, false);

  assert.deepEqual(quote, { kind: "relay" });
  assert.equal(huddleCostCaption(quote), null);
  assert.equal(joinGatedOnQuote(quote), false);
});

test("a quoted TOON fee becomes a per-minute ceiling with the VAD caveat", async () => {
  // The devnet's live frame fee: 1000 base units (0.001 USDC) per packet.
  const quote = await quoteHuddleFee(
    { quoteFee: () => Promise.resolve(1000n) },
    true,
  );

  assert.deepEqual(quote, {
    kind: "quoted",
    perMinuteCeilingBaseUnits: 3_000_000n,
  });
  const caption = huddleCostCaption(quote);
  assert.match(caption, /up to/);
  assert.match(caption, /3\.00 USDC\/min/);
  // The estimate is a ceiling, not the price: silence publishes nothing.
  assert.match(caption, /only pay while speaking/);
  assert.equal(joinGatedOnQuote(quote), false);
});

test("a failed quote says so honestly and does not brick joining", async () => {
  const quote = await quoteHuddleFee(
    { quoteFee: () => Promise.reject(new Error("no route")) },
    true,
  );

  assert.deepEqual(quote, { kind: "unavailable" });
  assert.match(huddleCostCaption(quote), /paid on this network/);
  assert.equal(joinGatedOnQuote(quote), false);
});

test("a missing transport in TOON mode reads as unavailable, not free", async () => {
  const quote = await quoteHuddleFee(null, true);

  assert.deepEqual(quote, { kind: "unavailable" });
});

test("only the pending state gates the join", () => {
  // Cost must have had its chance to render before a join — but once it has
  // (even as an honest failure), the button opens.
  assert.equal(joinGatedOnQuote({ kind: "pending" }), true);
  assert.match(huddleCostCaption({ kind: "pending" }), /Checking/);
});
