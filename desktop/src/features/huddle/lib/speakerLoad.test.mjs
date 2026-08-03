import assert from "node:assert/strict";
import test from "node:test";

import {
  GUARANTEED_CONCURRENT_SPEAKERS,
  OPPORTUNISTIC_CONCURRENT_SPEAKERS,
  speakerLoadHint,
} from "./speakerLoad.ts";

/**
 * The buzz#23 stage-3 soft speaker cap: ≤3 concurrent speakers guaranteed
 * (measured ADR 0003 bar), 4–10 opportunistic, beyond that sharply degraded.
 * Soft means hint, never gate — these tests pin the thresholds and the
 * TOON-only scoping.
 */

test("the measured envelope is 3 guaranteed / 10 opportunistic", () => {
  assert.equal(GUARANTEED_CONCURRENT_SPEAKERS, 3);
  assert.equal(OPPORTUNISTIC_CONCURRENT_SPEAKERS, 10);
});

test("within the guaranteed envelope there is nothing to warn about", () => {
  for (const n of [0, 1, 2, 3]) {
    assert.equal(speakerLoadHint(n, true), null, `${n} speakers`);
  }
});

test("the opportunistic band warns softly", () => {
  const hint = speakerLoadHint(4, true);
  assert.match(hint, /4 people are speaking/);
  assert.match(hint, /may degrade above 3/);
  assert.match(speakerLoadHint(10, true), /may degrade/);
});

test("beyond the opportunistic band the warning sharpens", () => {
  assert.match(speakerLoadHint(11, true), /degrades sharply above 10/);
});

test("the relay transport never shows the TOON envelope's hint", () => {
  assert.equal(speakerLoadHint(8, false), null);
});
