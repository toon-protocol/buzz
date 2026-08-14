import assert from "node:assert/strict";
import test from "node:test";

import {
  HUDDLE_LOW_COLLATERAL_SECONDS,
  deriveHuddleCollateralStatus,
  formatRemainingSpeechTime,
  huddleCollateralCaption,
} from "./huddleLowCollateral.ts";

/**
 * Covers buzz#68: the mid-huddle low-collateral warning built on top of
 * #67's fee quote. `perMinuteCeilingBaseUnits` is the same ceiling rate the
 * pre-join cost caption already quotes, so "remaining speech time" here is
 * balance ÷ ceiling — a conservative floor on how long speaking can
 * continue, not an average.
 */

test("relay mode (no fee quote) has nothing to warn about", () => {
  const status = deriveHuddleCollateralStatus({ kind: "relay" }, 0n);
  assert.deepEqual(status, { kind: "unknown" });
  assert.equal(huddleCollateralCaption(status), null);
});

test("a pending or unavailable quote has nothing to warn about", () => {
  assert.deepEqual(
    deriveHuddleCollateralStatus({ kind: "pending" }, 1_000_000n),
    {
      kind: "unknown",
    },
  );
  assert.deepEqual(
    deriveHuddleCollateralStatus({ kind: "unavailable" }, 1_000_000n),
    { kind: "unknown" },
  );
});

test("an unknown balance has nothing to warn about", () => {
  const quote = { kind: "quoted", perMinuteCeilingBaseUnits: 3_000_000n };
  const status = deriveHuddleCollateralStatus(quote, null);
  assert.deepEqual(status, { kind: "unknown" });
  assert.equal(huddleCollateralCaption(status), null);
});

test("a zero-cost quote has nothing to warn about", () => {
  const quote = { kind: "quoted", perMinuteCeilingBaseUnits: 0n };
  const status = deriveHuddleCollateralStatus(quote, 1_000_000n);
  assert.deepEqual(status, { kind: "unknown" });
});

test("plenty of runway reads as sufficient, no caption", () => {
  // 3 USDC/min ceiling, 10 USDC balance -> ~200s, well above the threshold.
  const quote = { kind: "quoted", perMinuteCeilingBaseUnits: 3_000_000n };
  const status = deriveHuddleCollateralStatus(quote, 10_000_000n);
  assert.equal(status.kind, "sufficient");
  assert.ok(status.remainingSeconds > HUDDLE_LOW_COLLATERAL_SECONDS);
  assert.equal(huddleCollateralCaption(status), null);
});

test("under the threshold reads as low, with a warning caption", () => {
  // 3 USDC/min ceiling, 0.02 USDC balance -> 0.4s.
  const quote = { kind: "quoted", perMinuteCeilingBaseUnits: 3_000_000n };
  const status = deriveHuddleCollateralStatus(quote, 20_000n);
  assert.equal(status.kind, "low");
  assert.ok(status.remainingSeconds < HUDDLE_LOW_COLLATERAL_SECONDS);
  const caption = huddleCollateralCaption(status);
  assert.match(caption, /Low balance/);
  assert.match(caption, /Add funds/);
});

test("exactly at the threshold is not yet low", () => {
  // 3 USDC/min == 50,000 base units/sec -> 60s of runway at exactly 3,000,000 base units.
  const quote = { kind: "quoted", perMinuteCeilingBaseUnits: 3_000_000n };
  const status = deriveHuddleCollateralStatus(quote, 3_000_000n);
  assert.equal(status.kind, "sufficient");
  assert.equal(status.remainingSeconds, HUDDLE_LOW_COLLATERAL_SECONDS);
});

test("formatRemainingSpeechTime renders seconds, minutes, hours, days", () => {
  assert.equal(formatRemainingSpeechTime(0), "0s");
  assert.equal(formatRemainingSpeechTime(0.4), "0s");
  assert.equal(formatRemainingSpeechTime(45), "45s");
  assert.equal(formatRemainingSpeechTime(59.6), "60s");
  assert.equal(formatRemainingSpeechTime(90), "2 min");
  assert.equal(formatRemainingSpeechTime(3600), "1 hr");
  assert.equal(formatRemainingSpeechTime(7200), "2 hr");
  assert.equal(formatRemainingSpeechTime(2 * 24 * 3600), "2 days");
});
