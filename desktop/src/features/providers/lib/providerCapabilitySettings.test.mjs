import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROVIDER_CAPABILITY_SETTINGS,
  getProviderCapabilitySettings,
  setProviderCapabilityStorage,
  setProviderCapabilitySettings,
  subscribeToProviderCapabilitySettings,
} from "./providerCapabilitySettings.ts";

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
  setProviderCapabilityStorage(memoryStorage());
});

test("an agent with no record reads as the disabled default", () => {
  assert.deepEqual(
    getProviderCapabilitySettings("agent-a"),
    DEFAULT_PROVIDER_CAPABILITY_SETTINGS,
  );
});

test("settings persist and read back", () => {
  const settings = {
    enabled: true,
    description: "TypeScript refactors, small to medium",
    repoFilter: ["toon-protocol/buzz"],
  };
  setProviderCapabilitySettings("agent-a", settings);
  assert.deepEqual(getProviderCapabilitySettings("agent-a"), settings);
});

test("settings are keyed per pubkey", () => {
  setProviderCapabilitySettings("agent-a", {
    enabled: true,
    description: "x",
    repoFilter: [],
  });
  assert.deepEqual(
    getProviderCapabilitySettings("agent-b"),
    DEFAULT_PROVIDER_CAPABILITY_SETTINGS,
  );
});

test("a corrupt/unreadable read is treated as the disabled default, never throws", () => {
  setProviderCapabilityStorage({
    getItem: () => {
      throw new Error("boom");
    },
    setItem: () => {},
    removeItem: () => {},
  });
  assert.deepEqual(
    getProviderCapabilitySettings("agent-a"),
    DEFAULT_PROVIDER_CAPABILITY_SETTINGS,
  );
});

test("a malformed stored value (wrong shape) is treated as the disabled default", () => {
  const store = memoryStorage();
  store.setItem(
    "buzz-provider-capability.v1:agent-a",
    JSON.stringify({ enabled: "yes" }),
  );
  setProviderCapabilityStorage(store);
  assert.deepEqual(
    getProviderCapabilitySettings("agent-a"),
    DEFAULT_PROVIDER_CAPABILITY_SETTINGS,
  );
});

test("subscribers are notified when settings change", () => {
  let notified = 0;
  const unsubscribe = subscribeToProviderCapabilitySettings(() => {
    notified += 1;
  });
  setProviderCapabilitySettings("agent-a", {
    enabled: true,
    description: "",
    repoFilter: [],
  });
  unsubscribe();
  setProviderCapabilitySettings(
    "agent-a",
    DEFAULT_PROVIDER_CAPABILITY_SETTINGS,
  );
  assert.equal(notified, 1);
});
