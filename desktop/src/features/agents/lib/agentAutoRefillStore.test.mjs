import assert from "node:assert/strict";
import test from "node:test";

import {
  currentUtcMonthKey,
  getAutoRefillConfig,
  getMonthlyRefillSpendBaseUnits,
  getRemainingCeilingBaseUnits,
  recordConfirmedRefillBaseUnits,
  setAgentAutoRefillStorage,
  setAutoRefillConfig,
} from "./agentAutoRefillStore.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

test.beforeEach(() => {
  setAgentAutoRefillStorage(memoryStorage());
});

const PUBKEY = "abc123";

// ── opt-in config: off by default, ceiling required to enable ──────────────

test("off by default for an agent with no stored config", () => {
  assert.deepEqual(getAutoRefillConfig(PUBKEY), { enabled: false });
});

test("enabling requires and persists a ceiling", () => {
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 5_000_000n });
  assert.deepEqual(getAutoRefillConfig(PUBKEY), {
    enabled: true,
    ceilingBaseUnits: 5_000_000n,
  });
});

test("disabling clears the ceiling from config but keeps the ledger", () => {
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 5_000_000n });
  recordConfirmedRefillBaseUnits(PUBKEY, 1_000_000n, new Date("2026-08-06"));
  setAutoRefillConfig(PUBKEY, { enabled: false });

  assert.deepEqual(getAutoRefillConfig(PUBKEY), { enabled: false });
  assert.equal(
    getMonthlyRefillSpendBaseUnits(PUBKEY, new Date("2026-08-06")),
    1_000_000n,
    "re-enabling mid-month must not silently reset spend — that would bypass the ceiling",
  );
});

test("config is keyed independently per agent pubkey", () => {
  setAutoRefillConfig("agent-a", { enabled: true, ceilingBaseUnits: 1n });
  assert.deepEqual(getAutoRefillConfig("agent-b"), { enabled: false });
});

// ── ceiling accounting: confirmed-only, floored, clamped ────────────────────

test("remaining ceiling is null when auto-refill is not enabled", () => {
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY), null);
});

test("confirmed refills subtract from the remaining ceiling", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 100n });
  recordConfirmedRefillBaseUnits(PUBKEY, 30n, now);
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, now), 70n);
  recordConfirmedRefillBaseUnits(PUBKEY, 30n, now);
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, now), 40n);
});

test("remaining ceiling floors at zero rather than going negative", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 10n });
  recordConfirmedRefillBaseUnits(PUBKEY, 25n, now);
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, now), 0n);
});

test("a zero or negative amount is never recorded (a failed deposit must not eat ceiling)", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 100n });
  recordConfirmedRefillBaseUnits(PUBKEY, 0n, now);
  recordConfirmedRefillBaseUnits(PUBKEY, -5n, now);
  assert.equal(getMonthlyRefillSpendBaseUnits(PUBKEY, now), 0n);
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, now), 100n);
});

// ── month rollover: lazy on read, UTC-exact ─────────────────────────────────

test("currentUtcMonthKey formats as UTC YYYY-MM regardless of local offset", () => {
  // 23:30 UTC on the last day of the month — a local-time formatter in a
  // timezone ahead of UTC would already have rolled into the next month.
  assert.equal(currentUtcMonthKey(new Date("2026-01-31T23:30:00Z")), "2026-01");
  assert.equal(currentUtcMonthKey(new Date("2026-01-01T00:00:00Z")), "2026-01");
  assert.equal(currentUtcMonthKey(new Date("2026-12-01T00:00:00Z")), "2026-12");
});

test("spend from a prior month is invisible after rollover", () => {
  const august = new Date("2026-08-15T00:00:00Z");
  const september = new Date("2026-09-01T00:00:00Z");
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 100n });
  recordConfirmedRefillBaseUnits(PUBKEY, 90n, august);

  assert.equal(getMonthlyRefillSpendBaseUnits(PUBKEY, august), 90n);
  assert.equal(getMonthlyRefillSpendBaseUnits(PUBKEY, september), 0n);
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, september), 100n);
});

test("a refill recorded after rollover starts a fresh month's ledger, not an accumulation", () => {
  const august = new Date("2026-08-15T00:00:00Z");
  const september = new Date("2026-09-02T00:00:00Z");
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 100n });
  recordConfirmedRefillBaseUnits(PUBKEY, 90n, august);
  recordConfirmedRefillBaseUnits(PUBKEY, 10n, september);

  assert.equal(getMonthlyRefillSpendBaseUnits(PUBKEY, september), 10n);
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, september), 90n);
});

test("rollover survives the app being closed across the boundary (lazy read, no timer)", () => {
  // Nothing touches the ledger between the two reads — nextMonth's read
  // alone must reflect the rollover.
  const lastOfMonth = new Date("2026-02-28T10:00:00Z");
  const nextMonth = new Date("2026-03-15T10:00:00Z");
  setAutoRefillConfig(PUBKEY, { enabled: true, ceilingBaseUnits: 50n });
  recordConfirmedRefillBaseUnits(PUBKEY, 50n, lastOfMonth);
  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, lastOfMonth), 0n);

  assert.equal(getRemainingCeilingBaseUnits(PUBKEY, nextMonth), 50n);
});
