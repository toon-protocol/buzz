import assert from "node:assert/strict";
import test from "node:test";

import {
  GUARANTEED_CONCURRENT_SPEAKERS,
  OPPORTUNISTIC_CONCURRENT_SPEAKERS,
  speakerLoadHint,
} from "./speakerLoad.ts";

/**
 * The buzz#23 stage-3 soft speaker cap, corrected per buzz#10's Phase F
 * multi-speaker aggregate checkpoint (the real ADR 0003 measurement, which
 * came back NO-GO): only a single speaker meets the ADR 0003 bar
 * (99.4% within 150ms); 2–3 concurrent speakers still deliver every frame
 * but late (90.6% / 73.6%); beyond that (N=5 measured) the edge fails
 * outright — dropped frames, not just late ones. Soft means hint, never
 * gate — these tests pin the thresholds and the TOON-only scoping.
 */

test("the measured envelope is 1 guaranteed / 3 opportunistic", () => {
  assert.equal(GUARANTEED_CONCURRENT_SPEAKERS, 1);
  assert.equal(OPPORTUNISTIC_CONCURRENT_SPEAKERS, 3);
});

test("within the guaranteed envelope there is nothing to warn about", () => {
  for (const n of [0, 1]) {
    assert.equal(speakerLoadHint(n, true), null, `${n} speakers`);
  }
});

test("the opportunistic band warns softly", () => {
  const hint = speakerLoadHint(2, true);
  assert.match(hint, /2 people are speaking/);
  assert.match(hint, /may degrade above 1/);
  assert.match(speakerLoadHint(3, true), /may degrade/);
});

test("beyond the opportunistic band the warning sharpens", () => {
  assert.match(speakerLoadHint(4, true), /degrades sharply above 3/);
});

test("the relay transport never shows the TOON envelope's hint", () => {
  assert.equal(speakerLoadHint(8, false), null);
});
