import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHANNEL_COLLATERAL_BASE_UNITS } from "../../onboarding/toon/toonOnboardingFormat.ts";
import {
  FALLBACK_RUNWAY_DAYS,
  FALLBACK_WRITES_PER_DAY,
  deriveInitialAllowanceBaseUnits,
} from "./agentProvisioningAllowance.ts";

test("no history, no quote — falls back to the devnet channel-open default", () => {
  const amount = deriveInitialAllowanceBaseUnits({
    measuredBurnRateBaseUnitsPerSec: null,
    quotedWritePriceBaseUnits: null,
  });
  assert.equal(amount, DEFAULT_CHANNEL_COLLATERAL_BASE_UNITS);
});

test("no history — sizes from the quoted per-write price and the fallback runway", () => {
  const amount = deriveInitialAllowanceBaseUnits({
    measuredBurnRateBaseUnitsPerSec: null,
    quotedWritePriceBaseUnits: 1_000n,
  });
  assert.equal(
    amount,
    1_000n * BigInt(FALLBACK_WRITES_PER_DAY) * BigInt(FALLBACK_RUNWAY_DAYS),
  );
});

test("no history — a custom runwayDays scales the fallback estimate", () => {
  const amount = deriveInitialAllowanceBaseUnits({
    measuredBurnRateBaseUnitsPerSec: null,
    quotedWritePriceBaseUnits: 1_000n,
    runwayDays: 1,
  });
  assert.equal(amount, 1_000n * BigInt(FALLBACK_WRITES_PER_DAY));
});

test("a measured burn rate wins over the quoted-price fallback", () => {
  const amount = deriveInitialAllowanceBaseUnits({
    // 10 base units/sec sustained.
    measuredBurnRateBaseUnitsPerSec: 10,
    quotedWritePriceBaseUnits: 1_000_000n,
    runwayDays: 1,
  });
  assert.equal(amount, 10n * 24n * 60n * 60n);
});

test("a zero measured burn rate is not trusted — falls through to the quote", () => {
  // A perfectly idle sample must not size a zero allowance; the agent still
  // needs enough to make its next write.
  const amount = deriveInitialAllowanceBaseUnits({
    measuredBurnRateBaseUnitsPerSec: 0,
    quotedWritePriceBaseUnits: 1_000n,
    runwayDays: 1,
  });
  assert.equal(amount, 1_000n * BigInt(FALLBACK_WRITES_PER_DAY));
});

test("a fractional burn-rate*runway amount rounds up, never under-funds", () => {
  const amount = deriveInitialAllowanceBaseUnits({
    measuredBurnRateBaseUnitsPerSec: 1.5,
    quotedWritePriceBaseUnits: null,
    runwayDays: 1,
  });
  assert.equal(amount, BigInt(Math.ceil(1.5 * 24 * 60 * 60)));
});
