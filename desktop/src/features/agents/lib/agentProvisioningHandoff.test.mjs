import assert from "node:assert/strict";
import test from "node:test";

import { shouldHandoffToProvisioning } from "./agentProvisioningHandoff.ts";

const created = {
  agent: { pubkey: "agent-a", name: "Agent A" },
  spawnError: null,
};

test("hands off once createdAgent transitions from set to null", () => {
  assert.equal(shouldHandoffToProvisioning(created, null), true);
});

test("does not hand off while createdAgent is still set", () => {
  assert.equal(shouldHandoffToProvisioning(created, created), false);
});

test("does not hand off when there was nothing created before", () => {
  assert.equal(shouldHandoffToProvisioning(null, null), false);
});

test("does not hand off for an agent that failed to spawn", () => {
  const failed = { ...created, spawnError: "boom" };
  assert.equal(shouldHandoffToProvisioning(failed, null), false);
});
