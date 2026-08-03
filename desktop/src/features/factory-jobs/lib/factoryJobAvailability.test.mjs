import assert from "node:assert/strict";
import test from "node:test";

import {
  factoryJobAvailability,
  factoryJobAvailabilityCaption,
} from "./factoryJobAvailability.ts";

test("relay transport has no job market to show", () => {
  const availability = factoryJobAvailability(null, false);
  assert.deepEqual(availability, { kind: "relay" });
  assert.match(factoryJobAvailabilityCaption(availability), /runs on TOON/);
});

test("TOON mode without a live transport reads as unavailable, not empty", () => {
  const availability = factoryJobAvailability(null, true);
  assert.deepEqual(availability, { kind: "unavailable" });
  assert.match(factoryJobAvailabilityCaption(availability), /can't be reached/);
});

test("TOON mode with a live transport is ready, with no caption to show", () => {
  const fakeTransport = {};
  const availability = factoryJobAvailability(fakeTransport, true);
  assert.equal(availability.kind, "ready");
  assert.equal(availability.transport, fakeTransport);
  assert.equal(factoryJobAvailabilityCaption(availability), null);
});
