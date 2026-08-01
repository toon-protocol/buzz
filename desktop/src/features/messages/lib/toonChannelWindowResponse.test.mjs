import assert from "node:assert/strict";
import test from "node:test";

import {
  appendOlderChannelWindow,
  emptyChannelWindowStore,
  replaceNewestChannelWindow,
} from "./channelWindowStore.ts";
import {
  assembleToonChannelWindowPage,
  buildToonHistoryFilter,
} from "./toonChannelWindowResponse.ts";

function event(id, createdAt, tags = [], content = id) {
  return {
    id: id.padEnd(64, "0"),
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind: 9,
    tags: [["h", "channel"], ...tags],
    content,
    sig: "b".repeat(128),
  };
}

const replyTag = (parentId) => ["e", parentId.padEnd(64, "0"), "", "reply"];

test("buildToonHistoryFilter requests the channel's timeline kinds with no until on the head page", () => {
  const filter = buildToonHistoryFilter("channel", null, 50);
  assert.deepEqual(filter["#h"], ["channel"]);
  assert.equal(filter.limit, 50);
  assert.ok(filter.kinds.includes(9));
  assert.equal("until" in filter, false);
});

test("buildToonHistoryFilter walks backwards with until on a scroll-back page", () => {
  const cursor = { createdAt: 500, eventId: "a".repeat(64) };
  const filter = buildToonHistoryFilter("channel", cursor, 50);
  assert.equal(filter.until, 500);
});

test("reorders a shuffled relay response into stable relay order", () => {
  const a = event("a", 300);
  const b = event("b", 200);
  const c = event("c", 200);
  const d = event("d", 100);
  // Arrives out of order, as a relay is free to deliver a REQ's matches.
  const page = assembleToonChannelWindowPage([d, b, a, c], null, 10);
  assert.deepEqual(
    page.rows.map((row) => row.event.id),
    [a.id, b.id, c.id, d.id],
  );
});

test("dedups duplicate deliveries of the same event id by id, not by reference", () => {
  const a = event("a", 300);
  const aAgain = { ...a };
  const b = event("b", 200);
  const page = assembleToonChannelWindowPage([a, b, aAgain], null, 10);
  assert.deepEqual(
    page.rows.map((row) => row.event.id),
    [a.id, b.id],
  );
});

test("a full raw page reports hasMore and a cursor at the oldest fetched event", () => {
  const events = [event("a", 300), event("b", 200), event("c", 100)];
  const page = assembleToonChannelWindowPage(events, null, 3);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextCursor, { createdAt: 100, eventId: events[2].id });
});

test("a short raw page proves history is exhausted", () => {
  const events = [event("a", 300), event("b", 200)];
  const page = assembleToonChannelWindowPage(events, null, 50);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("an empty raw page is exhausted, not merely unresolved", () => {
  const page = assembleToonChannelWindowPage([], null, 50);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.rows, []);
});

test("filters thread replies out of the visible rows, mirroring buzz-relay's top_level filter", () => {
  const root = event("a", 300);
  const reply = event("b", 200, [replyTag("a")]);
  const page = assembleToonChannelWindowPage([root, reply], null, 10);
  assert.deepEqual(
    page.rows.map((row) => row.event.id),
    [root.id],
  );
});

test("a page that is entirely thread replies still advances the cursor instead of looping", () => {
  // Nothing here would render a row (every event is a reply), but the relay
  // still handed back a full page — the same shape a page of entirely
  // undecryptable/tombstoned content would have once opened upstream. If
  // `hasMore` were derived from visible rows instead of the raw fetch, this
  // would report `hasMore: false` (0 rows) and freeze "load older" forever
  // even though there is more history above the cursor.
  const cursor = { createdAt: 1_000, eventId: "z".repeat(64) };
  const replies = [
    event("a", 300, [replyTag("root")]),
    event("b", 200, [replyTag("root")]),
  ];
  const page = assembleToonChannelWindowPage(replies, cursor, 2);
  assert.deepEqual(page.rows, []);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextCursor, { createdAt: 200, eventId: replies[1].id });
});

test("re-delivery of the requesting cursor's boundary event is excluded, not resurrected", () => {
  // NIP-01 `until` is inclusive, so a REQ built from a prior page's boundary
  // routinely re-includes the event that boundary came from.
  const cursor = { createdAt: 100, eventId: "b".padEnd(64, "0") };
  const boundaryEvent = event("b", 100);
  const older = event("a", 50);
  const page = assembleToonChannelWindowPage(
    [boundaryEvent, older],
    cursor,
    10,
  );
  assert.deepEqual(
    page.rows.map((row) => row.event.id),
    [older.id],
  );
});

test("two overlapping TOON pages reassemble gap-free through the shared window store", () => {
  const first = assembleToonChannelWindowPage(
    [event("a", 300), event("b", 200)],
    null,
    2,
  );
  assert.equal(first.hasMore, true);

  // The relay answers the second REQ (until: first.nextCursor.createdAt) by
  // re-including the boundary event `b`, exactly as a real NIP-01 relay would.
  const second = assembleToonChannelWindowPage(
    [event("b", 200), event("c", 100)],
    first.nextCursor,
    2,
  );
  assert.deepEqual(
    second.rows.map((row) => row.event.id),
    [event("c", 100).id],
  );

  // appendOlderChannelWindow throws on any id overlap between retained pages —
  // this only passes because the boundary re-delivery above was filtered out.
  const combined = appendOlderChannelWindow(
    replaceNewestChannelWindow(emptyChannelWindowStore(), first),
    second,
  );
  assert.deepEqual(
    combined.pages.flatMap((page) => page.rows.map((row) => row.event.id)),
    [event("a", 300).id, event("b", 200).id, event("c", 100).id],
  );
});
