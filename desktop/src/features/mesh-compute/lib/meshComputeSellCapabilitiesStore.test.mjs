import assert from "node:assert/strict";
import test from "node:test";

import {
  getMeshComputeSellCapabilities,
  getMeshComputeSellCapabilitiesSnapshot,
  getMeshComputeSellCapabilitiesVersion,
  setMeshComputeSellCapabilities,
  setMeshComputeSellCapabilitiesStorage,
  subscribeToMeshComputeSellCapabilities,
} from "./meshComputeSellCapabilitiesStore.ts";

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
  setMeshComputeSellCapabilitiesStorage(memoryStorage());
});

test("reads null model/ceiling when nothing has been saved", () => {
  const capabilities = getMeshComputeSellCapabilities();
  assert.equal(capabilities.modelId, null);
  assert.equal(capabilities.maxVramGb, null);
});

test("a revision round-trips through storage", () => {
  setMeshComputeSellCapabilities({ modelId: "Qwen3-8B-Q4_K_M", maxVramGb: 24 });
  const capabilities = getMeshComputeSellCapabilities();
  assert.equal(capabilities.modelId, "Qwen3-8B-Q4_K_M");
  assert.equal(capabilities.maxVramGb, 24);
});

test("a revision survives a fresh read from the same backing storage", () => {
  const storage = memoryStorage();
  setMeshComputeSellCapabilitiesStorage(storage);
  setMeshComputeSellCapabilities({ modelId: "Gemma-4-E4B", maxVramGb: 11.5 });

  // Simulate a new module load reading the same persisted storage.
  setMeshComputeSellCapabilitiesStorage(storage);
  const capabilities = getMeshComputeSellCapabilities();
  assert.equal(capabilities.modelId, "Gemma-4-E4B");
  assert.equal(capabilities.maxVramGb, 11.5);
});

test("a blank model id is stored as unset, not an empty string", () => {
  setMeshComputeSellCapabilities({ modelId: "  ", maxVramGb: 16 });
  assert.equal(getMeshComputeSellCapabilities().modelId, null);
});

test("a non-positive VRAM ceiling is rejected, falling back to unset", () => {
  setMeshComputeSellCapabilities({ modelId: "Qwen3-8B", maxVramGb: 16 });
  setMeshComputeSellCapabilities({ modelId: "Qwen3-8B", maxVramGb: 0 });
  assert.equal(getMeshComputeSellCapabilities().maxVramGb, null);

  setMeshComputeSellCapabilities({ modelId: "Qwen3-8B", maxVramGb: -5 });
  assert.equal(getMeshComputeSellCapabilities().maxVramGb, null);
});

test("malformed stored JSON falls back to unset instead of throwing", () => {
  const storage = memoryStorage();
  storage.setItem("buzz-mesh-compute-sell-capabilities.v1", "not json");
  setMeshComputeSellCapabilitiesStorage(storage);
  const capabilities = getMeshComputeSellCapabilities();
  assert.equal(capabilities.modelId, null);
  assert.equal(capabilities.maxVramGb, null);
});

// ── revision observability (mirrors buzz#165's AC2 mechanism) ────────────

test("every revision bumps the version counter", () => {
  const before = getMeshComputeSellCapabilitiesVersion();
  setMeshComputeSellCapabilities({ modelId: "Qwen3-8B", maxVramGb: 16 });
  assert.ok(getMeshComputeSellCapabilitiesVersion() > before);
});

// ── snapshot caching (React error #185 guard) ─────────────────────────────

test("the snapshot is referentially stable between reads with no revision", () => {
  const first = getMeshComputeSellCapabilitiesSnapshot();
  const second = getMeshComputeSellCapabilitiesSnapshot();
  assert.equal(first, second);
});

test("the snapshot changes identity after a revision", () => {
  const before = getMeshComputeSellCapabilitiesSnapshot();
  setMeshComputeSellCapabilities({ modelId: "Qwen3-8B", maxVramGb: 16 });
  const after = getMeshComputeSellCapabilitiesSnapshot();
  assert.notEqual(before, after);
  assert.equal(after.modelId, "Qwen3-8B");
});

test("subscribers are notified on revision", () => {
  let notifications = 0;
  const unsubscribe = subscribeToMeshComputeSellCapabilities(() => {
    notifications++;
  });
  setMeshComputeSellCapabilities({ modelId: "Qwen3-8B", maxVramGb: 16 });
  unsubscribe();
  setMeshComputeSellCapabilities({ modelId: "Gemma-4-E4B", maxVramGb: 8 });
  assert.equal(notifications, 1);
});
