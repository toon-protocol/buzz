import assert from "node:assert/strict";
import test from "node:test";

import {
  canRefillNetworkSpend,
  deriveNetworkSpendState,
  formatBurnRatePerMinute,
  networkSpendRunwayCaption,
} from "./networkSpendState.ts";

/**
 * Covers #80: the Network spend block's discriminated union
 * (relay | pending | unavailable | quoted), mirroring the huddle fee
 * quote's shape, plus "can I act" answered separately from `kind`.
 */

const NO_LIVE = { burnRateBaseUnitsPerSec: 0, hasSample: false };
const RAW = {
  channelId: "channel-1",
  depositTotalBaseUnits: 10_000_000n,
  cumulativeClaimedBaseUnits: 4_000_000n,
  source: "claim-state",
};

test("not on TOON transport reads as relay, regardless of anything else", () => {
  const state = deriveNetworkSpendState({
    isToon: false,
    isSelf: true,
    raw: RAW,
    live: NO_LIVE,
  });
  assert.deepEqual(state, { kind: "relay" });
  assert.equal(canRefillNetworkSpend(state), false);
});

test("TOON active but viewing another agent — no per-agent read exists, so unavailable", () => {
  const state = deriveNetworkSpendState({
    isToon: true,
    isSelf: false,
    raw: RAW,
    live: NO_LIVE,
  });
  assert.deepEqual(state, { kind: "unavailable" });
});

test("read in flight reports pending", () => {
  const state = deriveNetworkSpendState({
    isToon: true,
    isSelf: true,
    raw: "pending",
    live: NO_LIVE,
  });
  assert.deepEqual(state, { kind: "pending" });
  assert.equal(canRefillNetworkSpend(state), false);
});

test("no channel ever opened for this identity reports unavailable, never blank", () => {
  const state = deriveNetworkSpendState({
    isToon: true,
    isSelf: true,
    raw: null,
    live: NO_LIVE,
  });
  assert.deepEqual(state, { kind: "unavailable" });
});

test("a real read quotes the block and carries its source through", () => {
  const state = deriveNetworkSpendState({
    isToon: true,
    isSelf: true,
    raw: RAW,
    live: { burnRateBaseUnitsPerSec: 2, hasSample: true },
  });
  assert.equal(state.kind, "quoted");
  if (state.kind !== "quoted") return;
  assert.equal(state.source, "claim-state");
  assert.equal(state.hasBurnSample, true);
  assert.equal(state.read.depositBaseUnits, 10_000_000n);
  assert.equal(state.read.owedBaseUnits, 4_000_000n);
  assert.equal(state.read.creditedBaseUnits, 0n);
  assert.equal(state.read.burnRateBaseUnitsPerSec, 2);
  assert.equal(canRefillNetworkSpend(state), true);
});

test("a claim-state failure degrades to the local source, still quoted, never blank", () => {
  const state = deriveNetworkSpendState({
    isToon: true,
    isSelf: true,
    raw: { ...RAW, source: "local" },
    live: NO_LIVE,
  });
  assert.equal(state.kind, "quoted");
  if (state.kind !== "quoted") return;
  assert.equal(state.source, "local");
});

test("runway caption says burn hasn't been measured yet when there is no sample", () => {
  const read = {
    depositBaseUnits: 10_000_000n,
    owedBaseUnits: 4_000_000n,
    creditedBaseUnits: 0n,
    burnRateBaseUnitsPerSec: 0,
    incomeRateBaseUnitsPerSec: 0,
    incomeSampleCount: 0,
  };
  const caption = networkSpendRunwayCaption(read, false);
  assert.match(caption, /hasn't been measured yet/);
  assert.match(caption, /6\.00/); // 10 - 4 = 6 USDC spendable
});

test("runway caption defers to the real runway derivation once a burn sample exists", () => {
  const read = {
    depositBaseUnits: 10_000_000n,
    owedBaseUnits: 4_000_000n,
    creditedBaseUnits: 0n,
    burnRateBaseUnitsPerSec: 100,
    incomeRateBaseUnitsPerSec: 0,
    incomeSampleCount: 0,
  };
  const caption = networkSpendRunwayCaption(read, true);
  assert.match(caption, /runway left/);
});

test("burn rate formats as a per-minute USDC caption", () => {
  // 100 base units/sec * 60 = 6000 base units/min = 0.006 USDC/min.
  assert.match(formatBurnRatePerMinute(100), /\/min$/);
});
