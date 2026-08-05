import assert from "node:assert/strict";
import test from "node:test";

import { describeSearchHitKind } from "./searchHitLabel.ts";

test("known kinds map to their existing labels", () => {
  assert.equal(describeSearchHitKind(1), "Note");
  assert.equal(describeSearchHitKind(45001), "Forum post");
  assert.equal(describeSearchHitKind(45003), "Forum reply");
  assert.equal(describeSearchHitKind(43001), "Agent job");
  assert.equal(describeSearchHitKind(43003), "Agent update");
  assert.equal(describeSearchHitKind(5097), "Agent job");
  assert.equal(describeSearchHitKind(7000), "Agent update");
  assert.equal(describeSearchHitKind(46010), "Approval request");
});

test("6097 (NIP-90 factory job result) gets its own label, not the generic fallback", () => {
  assert.equal(describeSearchHitKind(6097), "Agent job result");
});

test("unknown kinds fall back to the generic label", () => {
  assert.equal(describeSearchHitKind(99999), "Message");
});
