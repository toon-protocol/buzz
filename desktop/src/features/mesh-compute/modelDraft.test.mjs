import assert from "node:assert/strict";
import test from "node:test";

import {
  MESH_MODEL_DRAFT_STORAGE_KEY,
  readMeshModelDraft,
} from "./modelDraft.ts";

function withLocalStorage(fn) {
  const store = new Map();
  const original = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
  try {
    fn(globalThis.window.localStorage);
  } finally {
    globalThis.window = original;
  }
}

test("reads the model Share compute already persisted", () => {
  withLocalStorage((storage) => {
    storage.setItem(MESH_MODEL_DRAFT_STORAGE_KEY, "Qwen3-8B-Q4_K_M");
    assert.equal(readMeshModelDraft(), "Qwen3-8B-Q4_K_M");
  });
});

test("returns empty string when nothing has been saved yet", () => {
  withLocalStorage(() => {
    assert.equal(readMeshModelDraft(), "");
  });
});

test("returns empty string when localStorage throws (private/blocked storage)", () => {
  const original = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
    },
  };
  try {
    assert.equal(readMeshModelDraft(), "");
  } finally {
    globalThis.window = original;
  }
});
