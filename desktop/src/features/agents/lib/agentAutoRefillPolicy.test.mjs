import assert from "node:assert/strict";
import test from "node:test";

import {
  decideRefill,
  deriveRefillAmountBaseUnits,
  deriveSuggestedCeilingBaseUnits,
  SUGGESTED_CEILING_RUNWAY_DAYS,
} from "./agentAutoRefillPolicy.ts";

// ── buzz#132 trigger matrix ─────────────────────────────────────────────────
//
// A wrong "fire" here spends real money against a ceiling that exists
// precisely to bound a bug or runaway agent. The never-fire rows below flip
// exactly one input away from the all-green baseline to prove that gate
// alone holds the line.

const SECONDS_PER_DAY = 86_400;

function quotedState({
  remainingBaseUnits,
  burnRateBaseUnitsPerSec,
  hasBurnSample = true,
  incomeRateBaseUnitsPerSec = 0,
  incomeSampleCount = 0,
}) {
  return {
    kind: "quoted",
    read: {
      depositBaseUnits: remainingBaseUnits,
      owedBaseUnits: 0n,
      creditedBaseUnits: 0n,
      burnRateBaseUnitsPerSec,
      incomeRateBaseUnitsPerSec,
      incomeSampleCount,
    },
    source: "claim-state",
    hasBurnSample,
  };
}

/** All-green inputs: 1 day of runway (under the 3-day warning threshold),
 * opted in, ceiling remaining, nothing in flight — the ONLY fire case. */
function greenInputs(overrides = {}) {
  return {
    optedIn: true,
    state: quotedState({
      remainingBaseUnits: 1000n,
      burnRateBaseUnitsPerSec: 1000 / SECONDS_PER_DAY, // 1 day of runway
    }),
    remainingCeilingBaseUnits: 5000n,
    refillInFlight: false,
    ...overrides,
  };
}

test("fires when opted in, ceiling remains, and runway is under the warning threshold", () => {
  assert.equal(decideRefill(greenInputs()), "fire");
});

// ── never-fire rows: one gate red at a time ─────────────────────────────────

const NEVER_FIRE_ROWS = [
  ["opt-in toggle off", { optedIn: false }],
  ["state is relay (not on TOON)", { state: { kind: "relay" } }],
  ["state is pending", { state: { kind: "pending" } }],
  ["state is unavailable", { state: { kind: "unavailable" } }],
  [
    "no burn sample yet (a guess dressed as a reading)",
    {
      state: quotedState({
        remainingBaseUnits: 1000n,
        burnRateBaseUnitsPerSec: 1000 / SECONDS_PER_DAY,
        hasBurnSample: false,
      }),
    },
  ],
  ["ceiling already exhausted", { remainingCeilingBaseUnits: 0n }],
  ["ceiling negative (defensive)", { remainingCeilingBaseUnits: -1n }],
  ["a refill is already in flight", { refillInFlight: true }],
  [
    "agent is self-funding (trusted income covers burn)",
    {
      state: quotedState({
        remainingBaseUnits: 1000n,
        burnRateBaseUnitsPerSec: 1,
        incomeRateBaseUnitsPerSec: 1,
        incomeSampleCount: 3,
      }),
    },
  ],
];

for (const [label, overrides] of NEVER_FIRE_ROWS) {
  test(`never fires: ${label}`, () => {
    assert.equal(
      decideRefill(greenInputs(overrides)),
      "hold",
      `${label} must hold — a fire here spends unbounded money`,
    );
  });
}

// ── the warning-threshold boundary ──────────────────────────────────────────

test("arms (does not fire) while runway is healthy", () => {
  const healthy = greenInputs({
    state: quotedState({
      remainingBaseUnits: 1000n,
      burnRateBaseUnitsPerSec: 1000 / (SECONDS_PER_DAY * 5), // 5 days of runway
    }),
  });
  assert.equal(decideRefill(healthy), "arm");
});

test("fires the instant runway is fully depleted", () => {
  const depleted = greenInputs({
    state: quotedState({ remainingBaseUnits: 0n, burnRateBaseUnitsPerSec: 1 }),
  });
  assert.equal(decideRefill(depleted), "fire");
});

test("reuses the same warning threshold as the always-on alert", () => {
  // AGENT_FLEET_RUNWAY_WARNING_DAYS = 3 — refill must resolve the warning,
  // not fire later than it (which would train the user to ignore the alarm).
  const justUnderThreshold = greenInputs({
    state: quotedState({
      remainingBaseUnits: 1000n,
      burnRateBaseUnitsPerSec: 1000 / (SECONDS_PER_DAY * 2.9),
    }),
  });
  assert.equal(decideRefill(justUnderThreshold), "fire");

  const justOverThreshold = greenInputs({
    state: quotedState({
      remainingBaseUnits: 1000n,
      burnRateBaseUnitsPerSec: 1000 / (SECONDS_PER_DAY * 3.1),
    }),
  });
  assert.equal(decideRefill(justOverThreshold), "arm");
});

// ── refill amount: burn-rate derived, clamped to the remaining ceiling ─────

test("derives the refill amount from the measured burn rate", () => {
  const amount = deriveRefillAmountBaseUnits({
    burnRateBaseUnitsPerSec: 100,
    remainingCeilingBaseUnits: 1_000_000_000_000n,
  });
  // Same formula as agentProvisioningAllowance's fallback runway (7 days).
  assert.equal(amount, BigInt(Math.ceil(100 * SECONDS_PER_DAY * 7)));
});

test("clamps the derived amount to the remaining ceiling", () => {
  const amount = deriveRefillAmountBaseUnits({
    burnRateBaseUnitsPerSec: 100,
    remainingCeilingBaseUnits: 10n,
  });
  assert.equal(amount, 10n);
});

test("a partial refill (clamped) still beats none", () => {
  const amount = deriveRefillAmountBaseUnits({
    burnRateBaseUnitsPerSec: 100,
    remainingCeilingBaseUnits: 1n,
  });
  assert.equal(amount, 1n);
});

// ── suggested ceiling: pre-filled, requires explicit confirmation ──────────

test("suggests roughly a month of runway at the fallback rate", () => {
  assert.equal(SUGGESTED_CEILING_RUNWAY_DAYS, 28);
  const suggested = deriveSuggestedCeilingBaseUnits({
    measuredBurnRateBaseUnitsPerSec: null,
    quotedWritePriceBaseUnits: null,
  });
  assert.ok(suggested > 0n);
});
