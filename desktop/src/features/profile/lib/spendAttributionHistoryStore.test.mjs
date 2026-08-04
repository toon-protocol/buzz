import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSpendTrend,
  readSpendAttributionHistory,
  recordSpendAttributionCheckpoint,
} from "./spendAttributionHistoryStore.ts";

function installLocalStorageStub() {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  };
}

const RELAY_URL = "wss://relay.example";
const AGENT_PUBKEY = "agent-pubkey";

test("deriveSpendTrend reports zero delta for the first checkpoint", () => {
  const trend = deriveSpendTrend([
    { atMs: 1000, cumulativeClaimedBaseUnits: 50n },
  ]);
  assert.deepEqual(trend, [
    { atMs: 1000, deltaBaseUnits: 0n, cumulativeClaimedBaseUnits: 50n },
  ]);
});

test("deriveSpendTrend computes deltas between consecutive checkpoints, sorted by time", () => {
  const trend = deriveSpendTrend([
    { atMs: 2000, cumulativeClaimedBaseUnits: 80n },
    { atMs: 1000, cumulativeClaimedBaseUnits: 50n },
  ]);
  assert.deepEqual(trend, [
    { atMs: 1000, deltaBaseUnits: 0n, cumulativeClaimedBaseUnits: 50n },
    { atMs: 2000, deltaBaseUnits: 30n, cumulativeClaimedBaseUnits: 80n },
  ]);
});

test("deriveSpendTrend treats a watermark decrease (channel reset) as a fresh series start, never a negative spend", () => {
  const trend = deriveSpendTrend([
    { atMs: 1000, cumulativeClaimedBaseUnits: 80n },
    { atMs: 2000, cumulativeClaimedBaseUnits: 10n },
  ]);
  assert.deepEqual(trend, [
    { atMs: 1000, deltaBaseUnits: 0n, cumulativeClaimedBaseUnits: 80n },
    { atMs: 2000, deltaBaseUnits: 0n, cumulativeClaimedBaseUnits: 10n },
  ]);
});

test("recordSpendAttributionCheckpoint persists and readSpendAttributionHistory reads it back", () => {
  installLocalStorageStub();

  recordSpendAttributionCheckpoint(RELAY_URL, AGENT_PUBKEY, {
    atMs: 1000,
    cumulativeClaimedBaseUnits: 50n,
  });
  recordSpendAttributionCheckpoint(RELAY_URL, AGENT_PUBKEY, {
    atMs: 2000,
    cumulativeClaimedBaseUnits: 90n,
  });

  const history = readSpendAttributionHistory(RELAY_URL, AGENT_PUBKEY);
  assert.deepEqual(history, [
    { atMs: 1000, cumulativeClaimedBaseUnits: 50n },
    { atMs: 2000, cumulativeClaimedBaseUnits: 90n },
  ]);
});

test("recordSpendAttributionCheckpoint skips a checkpoint identical to the last one", () => {
  installLocalStorageStub();

  recordSpendAttributionCheckpoint(RELAY_URL, AGENT_PUBKEY, {
    atMs: 1000,
    cumulativeClaimedBaseUnits: 50n,
  });
  recordSpendAttributionCheckpoint(RELAY_URL, AGENT_PUBKEY, {
    atMs: 2000,
    cumulativeClaimedBaseUnits: 50n,
  });

  const history = readSpendAttributionHistory(RELAY_URL, AGENT_PUBKEY);
  assert.equal(history.length, 1);
});

test("readSpendAttributionHistory scopes by relay and agent pubkey independently", () => {
  installLocalStorageStub();

  recordSpendAttributionCheckpoint(RELAY_URL, AGENT_PUBKEY, {
    atMs: 1000,
    cumulativeClaimedBaseUnits: 50n,
  });
  recordSpendAttributionCheckpoint(RELAY_URL, "other-agent", {
    atMs: 1000,
    cumulativeClaimedBaseUnits: 999n,
  });

  const history = readSpendAttributionHistory(RELAY_URL, AGENT_PUBKEY);
  assert.equal(history.length, 1);
  assert.equal(history[0].cumulativeClaimedBaseUnits, 50n);
});

test("readSpendAttributionHistory returns an empty array when nothing is stored", () => {
  installLocalStorageStub();
  assert.deepEqual(readSpendAttributionHistory(RELAY_URL, AGENT_PUBKEY), []);
});

test("readSpendAttributionHistory returns an empty array for malformed JSON", () => {
  installLocalStorageStub();
  window.localStorage.setItem(
    `buzz-spend-attribution-history.v1:${RELAY_URL.toLowerCase()}:${AGENT_PUBKEY}`,
    "not json",
  );
  assert.deepEqual(readSpendAttributionHistory(RELAY_URL, AGENT_PUBKEY), []);
});
