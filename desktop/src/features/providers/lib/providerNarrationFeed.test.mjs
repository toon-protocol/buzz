import assert from "node:assert/strict";
import test from "node:test";

import { mergeOwnNarration } from "./providerNarrationFeed.ts";

/**
 * buzz#135 — the provider sees their own narration before the relay echo
 * (owner decision 2026-08-12). The contract this file pins is reconciliation:
 * the optimistic entry and its eventual echo are ONE message, never two, and
 * a publish that failed never reads as delivered.
 */

function wireNarration(eventId, narration, createdAt) {
  return {
    eventId,
    providerPubkey: "p".repeat(64),
    createdAt,
    rootJobId: "job-1",
    status: "processing",
    parentEventId: "quote-1",
    narration,
  };
}

function localNarration(overrides) {
  return {
    localKey: "local-1",
    eventId: null,
    message: "Starting now.",
    createdAt: 1_700_000_000,
    delivery: "sending",
    ...overrides,
  };
}

test("an optimistic narration renders before any relay echo exists", () => {
  const merged = mergeOwnNarration([], [localNarration()]);

  assert.deepEqual(merged, [
    {
      key: "local-1",
      narration: "Starting now.",
      createdAt: 1_700_000_000,
      delivery: "sending",
    },
  ]);
});

test("the relay echo replaces the optimistic entry rather than doubling it", () => {
  const merged = mergeOwnNarration(
    [wireNarration("event-1", "Starting now.", 1_700_000_001)],
    [localNarration({ eventId: "event-1", delivery: "sent" })],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "event-1");
  assert.equal(merged[0].delivery, "confirmed");
});

test("a failed publish still dedupes if the relay stored the event anyway", () => {
  // The id is stamped at SIGNING time, so a publish that threw after the
  // relay accepted the event cannot resurface as a second copy.
  const merged = mergeOwnNarration(
    [wireNarration("event-1", "Starting now.", 1_700_000_001)],
    [localNarration({ eventId: "event-1", delivery: "failed" })],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].delivery, "confirmed");
});

test("a failed publish with no echo stays visible and stays marked failed", () => {
  const merged = mergeOwnNarration(
    [],
    [localNarration({ eventId: "event-1", delivery: "failed" })],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].narration, "Starting now.");
  assert.equal(merged[0].delivery, "failed");
});

test("unrelated relay narration never swallows an optimistic entry", () => {
  const merged = mergeOwnNarration(
    [wireNarration("event-other", "An earlier update.", 1_699_999_000)],
    [localNarration({ eventId: "event-1", delivery: "sent" })],
  );

  assert.deepEqual(
    merged.map((entry) => entry.key),
    ["event-other", "local-1"],
  );
});

test("confirmed and optimistic entries interleave oldest-first", () => {
  const merged = mergeOwnNarration(
    [
      wireNarration("event-a", "First.", 10),
      wireNarration("event-c", "Third.", 30),
    ],
    [
      localNarration({
        localKey: "local-b",
        message: "Second.",
        createdAt: 20,
      }),
      localNarration({
        localKey: "local-d",
        message: "Fourth.",
        createdAt: 40,
      }),
    ],
  );

  assert.deepEqual(
    merged.map((entry) => entry.narration),
    ["First.", "Second.", "Third.", "Fourth."],
  );
});
