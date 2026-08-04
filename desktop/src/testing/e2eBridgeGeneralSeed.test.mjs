/**
 * Unit tests for the e2e bridge's general-channel seed message timestamps.
 *
 * The general channel's mock seed cluster spans 120s (welcome -> alice ->
 * reaction target -> system message join). formatDayHeading() buckets each
 * message by comparing its timestamp against the real `new Date()`, so an
 * unclamped "now minus N seconds" base can land the earliest seed on the
 * previous calendar day whenever a run starts within the first two minutes
 * after local midnight — splitting the cluster across a "Yesterday"/"Today"
 * divider pair. channels.spec.ts's "channel with messages shows content"
 * asserts exactly one divider, so the base must never precede local
 * midnight (buzz#105).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { generalChannelSeedBaseSec } from "./e2eBridge.ts";

test("clamps to local midnight when now is within the seed window of it", () => {
  const now = new Date(2026, 0, 5, 0, 0, 30); // 30s after local midnight
  const startOfToday = new Date(2026, 0, 5, 0, 0, 0).getTime() / 1000;

  assert.equal(generalChannelSeedBaseSec(now.getTime()), startOfToday);
});

test("uses now-minus-120s when that stays within today", () => {
  const now = new Date(2026, 0, 5, 12, 0, 0); // noon, far from midnight
  const expected = Math.floor(now.getTime() / 1000) - 120;

  assert.equal(generalChannelSeedBaseSec(now.getTime()), expected);
});

test("never returns a timestamp on the previous calendar day", () => {
  for (const secondsAfterMidnight of [0, 1, 60, 119, 120, 121, 3600]) {
    const now =
      new Date(2026, 0, 5, 0, 0, 0).getTime() + secondsAfterMidnight * 1000;
    const startOfToday = Math.floor(
      new Date(2026, 0, 5, 0, 0, 0).getTime() / 1000,
    );

    assert.ok(
      generalChannelSeedBaseSec(now) >= startOfToday,
      `base for +${secondsAfterMidnight}s should not precede local midnight`,
    );
  }
});
