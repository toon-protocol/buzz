import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  getNetworkSpendLiveSnapshot,
  recordNetworkSpendWrite,
  resetNetworkSpendLiveStore,
  subscribeNetworkSpendLive,
} from "./networkSpendLiveStore.ts";

/**
 * Covers #80's live-spend half: a module-level trailing-window store fed by
 * `ToonEventTransport.onPaidWrite`, the burn-rate source
 * `agentNetworkFlow.ts`'s `NetworkFlowRead.burnRateBaseUnitsPerSec` reads
 * from for the currently active identity.
 */

beforeEach(() => {
  resetNetworkSpendLiveStore();
});

test("no writes yet — no sample, zero rate", () => {
  assert.deepEqual(getNetworkSpendLiveSnapshot(), {
    burnRateBaseUnitsPerSec: 0,
    hasSample: false,
  });
});

test("a write inside the window contributes to the burn rate", () => {
  recordNetworkSpendWrite({
    eventId: "e1",
    amount: 300n,
    assetScale: 6,
    asset: "USDC",
    destination: "g.toon.relay",
  });
  const snapshot = getNetworkSpendLiveSnapshot();
  assert.equal(snapshot.hasSample, true);
  // 300 base units / 300s window = 1 base unit/sec.
  assert.equal(snapshot.burnRateBaseUnitsPerSec, 1);
});

test("multiple writes inside the window sum together", () => {
  recordNetworkSpendWrite({
    eventId: "e1",
    amount: 300n,
    assetScale: 6,
    asset: "USDC",
    destination: "g.toon.relay",
  });
  recordNetworkSpendWrite({
    eventId: "e2",
    amount: 600n,
    assetScale: 6,
    asset: "USDC",
    destination: "g.toon.relay",
  });
  const snapshot = getNetworkSpendLiveSnapshot();
  // (300 + 600) / 300s = 3 base units/sec.
  assert.equal(snapshot.burnRateBaseUnitsPerSec, 3);
});

test("reset clears every recorded write", () => {
  recordNetworkSpendWrite({
    eventId: "e1",
    amount: 300n,
    assetScale: 6,
    asset: "USDC",
    destination: "g.toon.relay",
  });
  resetNetworkSpendLiveStore();
  assert.deepEqual(getNetworkSpendLiveSnapshot(), {
    burnRateBaseUnitsPerSec: 0,
    hasSample: false,
  });
});

test("subscribers are notified on write and on reset", () => {
  let notifications = 0;
  const unsubscribe = subscribeNetworkSpendLive(() => {
    notifications += 1;
  });

  recordNetworkSpendWrite({
    eventId: "e1",
    amount: 300n,
    assetScale: 6,
    asset: "USDC",
    destination: "g.toon.relay",
  });
  assert.equal(notifications, 1);

  resetNetworkSpendLiveStore();
  assert.equal(notifications, 2);

  unsubscribe();
  recordNetworkSpendWrite({
    eventId: "e2",
    amount: 300n,
    assetScale: 6,
    asset: "USDC",
    destination: "g.toon.relay",
  });
  assert.equal(notifications, 2);
});

test("getNetworkSpendLiveSnapshot returns a stable reference when nothing changed", () => {
  recordNetworkSpendWrite({
    eventId: "e1",
    amount: 300n,
    assetScale: 6,
    asset: "USDC",
    destination: "g.toon.relay",
  });
  const first = getNetworkSpendLiveSnapshot();
  const second = getNetworkSpendLiveSnapshot();
  assert.equal(first, second);
});
