import assert from "node:assert/strict";
import test from "node:test";

import {
  attributeObservedSpend,
  eventChannelId,
  reconcileSpend,
  toObservedAgentEvents,
} from "./agentSpendAttribution.ts";

test("eventChannelId reads the h tag", () => {
  assert.equal(
    eventChannelId([
      ["h", "general"],
      ["p", "abc"],
    ]),
    "general",
  );
});

test("eventChannelId returns null when there is no h tag", () => {
  assert.equal(eventChannelId([["p", "abc"]]), null);
});

test("eventChannelId returns null for an h tag with no value", () => {
  assert.equal(eventChannelId([["h"]]), null);
});

test("toObservedAgentEvents drops events with no channel tag", () => {
  const events = [
    { id: "1", kind: 9, created_at: 100, tags: [["h", "general"]] },
    { id: "2", kind: 9, created_at: 200, tags: [] },
  ];
  const observed = toObservedAgentEvents(events);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], {
    eventId: "1",
    channelId: "general",
    kind: 9,
    createdAt: 100,
  });
});

test("attributeObservedSpend groups by channel and kind, priced flat per event", () => {
  const events = [
    { eventId: "1", channelId: "general", kind: 9, createdAt: 100 },
    { eventId: "2", channelId: "general", kind: 9, createdAt: 200 },
    { eventId: "3", channelId: "general", kind: 7, createdAt: 300 },
    { eventId: "4", channelId: "random", kind: 9, createdAt: 400 },
  ];

  const breakdown = attributeObservedSpend(events, 5n);

  assert.equal(breakdown.attributedBaseUnits, 20n);
  assert.deepEqual(breakdown.byChannelKind, [
    { channelId: "general", kind: 7, eventCount: 1, baseUnits: 5n },
    { channelId: "general", kind: 9, eventCount: 2, baseUnits: 10n },
    { channelId: "random", kind: 9, eventCount: 1, baseUnits: 5n },
  ]);
});

test("attributeObservedSpend on no events attributes nothing", () => {
  const breakdown = attributeObservedSpend([], 5n);
  assert.equal(breakdown.attributedBaseUnits, 0n);
  assert.deepEqual(breakdown.byChannelKind, []);
});

test("reconcileSpend reports unverified with no connector total", () => {
  const result = reconcileSpend({
    attributedBaseUnits: 30n,
    connectorTotalBaseUnits: null,
  });
  assert.deepEqual(result, { kind: "unverified", attributedBaseUnits: 30n });
});

test("reconcileSpend surfaces the gap as an explicit unattributed remainder", () => {
  const result = reconcileSpend({
    attributedBaseUnits: 30n,
    connectorTotalBaseUnits: 100n,
  });
  assert.deepEqual(result, {
    kind: "reconciled",
    attributedBaseUnits: 30n,
    connectorTotalBaseUnits: 100n,
    unattributedRemainderBaseUnits: 70n,
  });
});

test("reconcileSpend floors the remainder at zero rather than going negative", () => {
  const result = reconcileSpend({
    attributedBaseUnits: 120n,
    connectorTotalBaseUnits: 100n,
  });
  assert.equal(result.kind, "reconciled");
  assert.equal(result.unattributedRemainderBaseUnits, 0n);
});

test("reconcileSpend with full visibility reports a zero remainder", () => {
  const result = reconcileSpend({
    attributedBaseUnits: 100n,
    connectorTotalBaseUnits: 100n,
  });
  assert.equal(result.kind, "reconciled");
  assert.equal(result.unattributedRemainderBaseUnits, 0n);
});
