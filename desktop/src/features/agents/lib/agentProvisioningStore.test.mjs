import assert from "node:assert/strict";
import test from "node:test";

import {
  isAgentChannelConfirmed,
  isAgentProvisioningDeclined,
  setAgentChannelConfirmed,
  setAgentProvisioningDeclined,
  setAgentProvisioningStorage,
  subscribeToAgentProvisioningState,
} from "./agentProvisioningStore.ts";

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
  setAgentProvisioningStorage(memoryStorage());
});

test("an agent with no record reads as not confirmed", () => {
  assert.equal(isAgentChannelConfirmed("agent-a"), false);
});

test("confirming an agent's channel persists and reads back true", () => {
  setAgentChannelConfirmed("agent-a", true);
  assert.equal(isAgentChannelConfirmed("agent-a"), true);
});

test("confirming one agent does not confirm another — keyed per pubkey", () => {
  setAgentChannelConfirmed("agent-a", true);
  assert.equal(isAgentChannelConfirmed("agent-b"), false);
});

test("un-confirming clears the flag", () => {
  setAgentChannelConfirmed("agent-a", true);
  setAgentChannelConfirmed("agent-a", false);
  assert.equal(isAgentChannelConfirmed("agent-a"), false);
});

test("a corrupt/unreadable storage read is treated as not confirmed, never throws", () => {
  setAgentProvisioningStorage({
    getItem: () => {
      throw new Error("boom");
    },
    setItem: () => {},
    removeItem: () => {},
  });
  assert.equal(isAgentChannelConfirmed("agent-a"), false);
});

test("subscribers are notified when a flag changes", () => {
  let notified = 0;
  const unsubscribe = subscribeToAgentProvisioningState(() => {
    notified += 1;
  });
  setAgentChannelConfirmed("agent-a", true);
  unsubscribe();
  setAgentChannelConfirmed("agent-a", false);
  assert.equal(notified, 1);
});

test("an agent with no record reads as not declined", () => {
  assert.equal(isAgentProvisioningDeclined("agent-a"), false);
});

test("declining persists and reads back true, keyed per pubkey", () => {
  setAgentProvisioningDeclined("agent-a", true);
  assert.equal(isAgentProvisioningDeclined("agent-a"), true);
  assert.equal(isAgentProvisioningDeclined("agent-b"), false);
});

test("un-declining clears the flag", () => {
  setAgentProvisioningDeclined("agent-a", true);
  setAgentProvisioningDeclined("agent-a", false);
  assert.equal(isAgentProvisioningDeclined("agent-a"), false);
});

test("the declined flag and the channel-confirmed flag are independent", () => {
  setAgentProvisioningDeclined("agent-a", true);
  assert.equal(isAgentChannelConfirmed("agent-a"), false);
  setAgentChannelConfirmed("agent-a", true);
  assert.equal(isAgentProvisioningDeclined("agent-a"), true);
});

test("a corrupt/unreadable storage read is treated as not declined, never throws", () => {
  setAgentProvisioningStorage({
    getItem: () => {
      throw new Error("boom");
    },
    setItem: () => {},
    removeItem: () => {},
  });
  assert.equal(isAgentProvisioningDeclined("agent-a"), false);
});
