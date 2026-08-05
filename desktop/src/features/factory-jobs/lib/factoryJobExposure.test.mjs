import assert from "node:assert/strict";
import test from "node:test";

import {
  checkOfferPayable,
  deriveFactoryJobExposure,
  factoryJobExposureCaption,
} from "./factoryJobExposure.ts";

const SCHEDULE = [
  { n: 1, priceUsdcBaseUnits: 500_000n },
  { n: 2, priceUsdcBaseUnits: 4_000_000n },
  { n: 3, priceUsdcBaseUnits: 500_000n },
];

test("nothing paid: full amount remains at risk, none spent", () => {
  const exposure = deriveFactoryJobExposure(SCHEDULE, new Set());
  assert.deepEqual(exposure, {
    paidCount: 0,
    totalCount: 3,
    paidAmountBaseUnits: 0n,
    nextIncrementAmountBaseUnits: 500_000n,
    remainingAmountBaseUnits: 5_000_000n,
    isComplete: false,
  });
  assert.match(
    factoryJobExposureCaption(exposure),
    /Stopping now costs nothing\./,
  );
});

test("mid-job: paid so far and stopping cost are both stated", () => {
  const exposure = deriveFactoryJobExposure(SCHEDULE, new Set([1]));
  assert.deepEqual(exposure, {
    paidCount: 1,
    totalCount: 3,
    paidAmountBaseUnits: 500_000n,
    nextIncrementAmountBaseUnits: 4_000_000n,
    remainingAmountBaseUnits: 4_500_000n,
    isComplete: false,
  });
  const caption = factoryJobExposureCaption(exposure);
  assert.match(caption, /Paid 1 of 3 increments/);
  assert.match(caption, /0\.50 USDC/);
  assert.match(caption, /stopping now costs nothing further/);
});

test("only ever reports what was actually paid — never sums future risk into the past", () => {
  // Paying increment 3 without 1/2 (out of order) still counts correctly —
  // reputation/exposure is a byproduct of which increments were paid, not an
  // assumption about order.
  const exposure = deriveFactoryJobExposure(SCHEDULE, new Set([3]));
  assert.equal(exposure.paidAmountBaseUnits, 500_000n);
  assert.equal(exposure.paidCount, 1);
});

test("complete job: every increment paid", () => {
  const exposure = deriveFactoryJobExposure(SCHEDULE, new Set([1, 2, 3]));
  assert.equal(exposure.isComplete, true);
  assert.equal(exposure.remainingAmountBaseUnits, 0n);
  assert.equal(exposure.nextIncrementAmountBaseUnits, null);
  assert.match(factoryJobExposureCaption(exposure), /The job is complete\./);
});

test("no schedule yet: nothing to risk", () => {
  const exposure = deriveFactoryJobExposure([], new Set());
  assert.equal(exposure.totalCount, 0);
  assert.match(factoryJobExposureCaption(exposure), /nothing has been risked/);
});

test("checkOfferPayable: an offer matching the quoted increment price is payable", () => {
  const result = checkOfferPayable(
    { increment: { n: 2 }, amountBaseUnits: 4_000_000n },
    SCHEDULE,
  );
  assert.deepEqual(result, { payable: true });
});

test("checkOfferPayable: a provider inflating an increment's price is not payable, and says why (§4.1 MUST)", () => {
  const result = checkOfferPayable(
    { increment: { n: 2 }, amountBaseUnits: 4_500_000n },
    SCHEDULE,
  );
  assert.equal(result.payable, false);
  assert.match(result.reason, /4\.50 USDC/);
  assert.match(result.reason, /quoted at 4\.00 USDC/);
});

test("checkOfferPayable: an increment absent from the quoted schedule is not payable", () => {
  const result = checkOfferPayable(
    { increment: { n: 9 }, amountBaseUnits: 1n },
    SCHEDULE,
  );
  assert.equal(result.payable, false);
  assert.match(result.reason, /not in the quoted schedule/);
});
