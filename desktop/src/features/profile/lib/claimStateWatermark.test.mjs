import assert from "node:assert/strict";
import test from "node:test";

import { splitClaimStateWatermark } from "./claimStateWatermark.ts";

test("a positive watermark reads as cumulativeClaimed, zero credited", () => {
  const split = splitClaimStateWatermark({
    depositTotal: "10000000",
    cumulativeClaimed: "4000000",
  });
  assert.deepEqual(split, {
    depositTotalBaseUnits: 10_000_000n,
    cumulativeClaimedBaseUnits: 4_000_000n,
    creditedBaseUnits: 0n,
  });
});

test("a negative watermark splits into a credited amount, zero cumulativeClaimed (buzz#108)", () => {
  const split = splitClaimStateWatermark({
    depositTotal: "10000000",
    cumulativeClaimed: "-1500000",
  });
  assert.deepEqual(split, {
    depositTotalBaseUnits: 10_000_000n,
    cumulativeClaimedBaseUnits: 0n,
    creditedBaseUnits: 1_500_000n,
  });
});

test("a null depositTotal (connector only DECLARED the channel) reads as no verified split", () => {
  assert.equal(
    splitClaimStateWatermark({ depositTotal: null, cumulativeClaimed: "0" }),
    null,
  );
});
