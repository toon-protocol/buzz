import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveNetworkRunway,
  isEarning,
  netSpendableBaseUnits,
  networkRunwayCaption,
  shouldSuppressLowFundsAlert,
} from "./agentNetworkFlow.ts";

/**
 * Covers buzz#86: net flow (income beside spend, same channel) and a
 * runway that accounts for income without lying about a single lucky job.
 * Pure-function tests in the `paymentsOverview` / `huddleFeeQuote` mold —
 * no DOM, no network.
 */

const NO_INCOME = {
  depositBaseUnits: 10_000_000n,
  owedBaseUnits: 4_000_000n,
  creditedBaseUnits: 0n,
  burnRateBaseUnitsPerSec: 100,
  incomeRateBaseUnitsPerSec: 0,
  incomeSampleCount: 0,
};

test("net spendable nets income into the same channel, never a second pot", () => {
  const read = {
    ...NO_INCOME,
    creditedBaseUnits: 2_000_000n,
  };
  // deposit 10 - owed 4 + credited 2 = 8
  assert.equal(netSpendableBaseUnits(read), 8_000_000n);
});

test("net spendable floors at zero rather than going negative", () => {
  const read = {
    ...NO_INCOME,
    depositBaseUnits: 1_000_000n,
    owedBaseUnits: 1_500_000n,
  };
  assert.equal(netSpendableBaseUnits(read), 0n);
});

test("a depleted balance reports depleted regardless of rates", () => {
  const state = deriveNetworkRunway({
    ...NO_INCOME,
    depositBaseUnits: 1_000_000n,
    owedBaseUnits: 1_000_000n,
  });
  assert.deepEqual(state, { kind: "depleted" });
  assert.match(networkRunwayCaption(state), /depleted/);
});

test("no income yet — runway is finite, driven by burn rate alone", () => {
  const state = deriveNetworkRunway(NO_INCOME);
  assert.equal(state.kind, "finite");
  if (state.kind === "finite") {
    // 6,000,000 remaining / 100 base units per sec = 60,000s
    assert.equal(state.runwaySeconds, 60_000);
  }
  assert.match(networkRunwayCaption(state), /runway left/);
});

test("a single payment does not flip runway to indefinite", () => {
  // Income currently outpaces burn, but only one sample has ever landed —
  // must not be trusted as self-funding yet.
  const state = deriveNetworkRunway({
    ...NO_INCOME,
    incomeRateBaseUnitsPerSec: 500,
    incomeSampleCount: 1,
  });
  assert.equal(state.kind, "finite");
  assert.equal(isEarning(NO_INCOME) || false, false);
});

test("sustained income that covers burn is self-funding — no depletion date", () => {
  const read = {
    ...NO_INCOME,
    incomeRateBaseUnitsPerSec: 150,
    incomeSampleCount: 5,
  };
  const state = deriveNetworkRunway(read);
  assert.deepEqual(state, {
    kind: "self-funding",
    remainingBaseUnits: 6_000_000n,
  });
  assert.match(networkRunwayCaption(state), /no depletion date/);
  assert.equal(isEarning(read), true);
  assert.equal(shouldSuppressLowFundsAlert(read), true);
});

test("sustained income that only partially covers burn extends but does not erase runway", () => {
  const read = {
    ...NO_INCOME,
    incomeRateBaseUnitsPerSec: 40,
    incomeSampleCount: 4,
  };
  const state = deriveNetworkRunway(read);
  assert.equal(state.kind, "finite");
  if (state.kind === "finite") {
    // net burn = 100 - 40 = 60/sec; 6,000,000 / 60 = 100,000s
    assert.equal(state.runwaySeconds, 100_000);
  }
  assert.equal(isEarning(read), false);
  assert.equal(shouldSuppressLowFundsAlert(read), false);
});

test("low-funds alert is not suppressed while income is unproven", () => {
  const read = {
    ...NO_INCOME,
    incomeRateBaseUnitsPerSec: 500,
    incomeSampleCount: 2,
  };
  assert.equal(shouldSuppressLowFundsAlert(read), false);
});
