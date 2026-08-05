/**
 * Regression test for buzz#121: the Jobs screen crashed with React error
 * #185 ("Maximum update depth exceeded") the moment a provider flipped the
 * "Serve jobs from the open factory job market" toggle.
 *
 * Root cause: `ProviderJobsPanel` fed `useSyncExternalStore` a getSnapshot
 * that called `getProviderCapabilitySettings(pubkey)` directly.  That
 * function `JSON.parse`s the stored blob on every call, so once ANY settings
 * blob exists in storage, every render produces a new object identity.
 * `useSyncExternalStore` treats that as "the store changed mid-render",
 * forces another render, sees another new identity, and loops until React's
 * render-depth guard throws.
 *
 * The store had unit tests (providerCapabilitySettings.test.mjs) but nothing
 * mounted the hook the panel actually used — this file is that hook-level
 * coverage, per the issue's AC. It mounts the REAL production hook
 * (`useProviderCapabilitySettings`) with a settings blob already present in
 * storage (the exact trigger condition) and drives the toggle path
 * repeatedly. Reverting the hook to call `getProviderCapabilitySettings`
 * straight from `useSyncExternalStore` reproduces the crash here.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
// react-dom/client requires a small subset of the DOM API. Mirrors the shim
// used by MessageComposerDraftImagePersist.test.mjs / useLoadArchivedObserverEvents.test.mjs.

function installDOMShim() {
  class MinimalEventTarget {
    constructor() {
      this._listeners = {};
    }
    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
      }
    }
    dispatchEvent(e) {
      for (const fn of this._listeners[e.type] ?? []) fn(e);
      return true;
    }
  }

  class MinimalNode extends MinimalEventTarget {
    constructor(tagName) {
      super();
      this.tagName = tagName;
      this.children = [];
      this.childNodes = [];
      this.style = {};
      this.nodeType = 1;
      this.parentNode = null;
    }
    get ownerDocument() {
      return globalThis.document;
    }
    get firstChild() {
      return this.children[0] ?? null;
    }
    get lastChild() {
      return this.children[this.children.length - 1] ?? null;
    }
    get nextSibling() {
      return null;
    }
    get nodeValue() {
      return null;
    }
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    }
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      this.childNodes = this.childNodes.filter((c) => c !== child);
      return child;
    }
    insertBefore(newNode, refNode) {
      if (!refNode) return this.appendChild(newNode);
      const i = this.children.indexOf(refNode);
      if (i < 0) return this.appendChild(newNode);
      this.children.splice(i, 0, newNode);
      this.childNodes.splice(i, 0, newNode);
      newNode.parentNode = this;
      return newNode;
    }
    contains(node) {
      if (!node) return false;
      return this === node || this.children.some((c) => c?.contains?.(node));
    }
  }

  class MinimalDocument extends MinimalEventTarget {
    constructor() {
      super();
      this.nodeType = 9;
    }
    createElement(tagName) {
      return new MinimalNode(tagName);
    }
    createTextNode(value) {
      const n = new MinimalNode("#text");
      n.nodeValue = value;
      n.nodeType = 3;
      return n;
    }
    createComment(value) {
      const n = new MinimalNode("#comment");
      n.nodeValue = value;
      n.nodeType = 8;
      return n;
    }
    get body() {
      if (!this._body) this._body = this.createElement("body");
      return this._body;
    }
    get activeElement() {
      return null;
    }
    contains(node) {
      return node != null;
    }
  }

  globalThis.document = new MinimalDocument();
  globalThis.HTMLIFrameElement = MinimalNode;
  globalThis.HTMLElement = MinimalNode;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  process.env.IS_REACT_ACT_ENVIRONMENT = "true";

  if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: globalThis,
      configurable: true,
    });
  }
  if (!Object.getOwnPropertyDescriptor(globalThis, "navigator")?.value) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "node" },
      configurable: true,
    });
  }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

installDOMShim();

// ── Imports (after the DOM shim) ───────────────────────────────────────────

import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

import {
  getProviderCapabilitySettingsSnapshot,
  setProviderCapabilitySettings,
  setProviderCapabilityStorage,
  useProviderCapabilitySettings,
} from "./providerCapabilitySettings.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

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

/** Mount `useProviderCapabilitySettings` in a real React tree. */
function mountHook(pubkey) {
  const renders = { current: [] };

  function HarnessComponent() {
    const settings = useProviderCapabilitySettings(pubkey);
    renders.current.push(settings);
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);

  return {
    render: async () => {
      await act(async () => {
        root.render(React.createElement(HarnessComponent));
      });
    },
    renders,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

test.beforeEach(() => {
  setProviderCapabilityStorage(memoryStorage());
});

test("mounting with a stored settings blob does not crash (buzz#121 / React #185)", async () => {
  // The exact trigger condition from the issue: "once any settings blob
  // exists the snapshot identity changes every render".
  setProviderCapabilitySettings("agent-a", {
    enabled: false,
    description: "",
    repoFilter: [],
  });

  const { render, renders, unmount } = mountHook("agent-a");
  await render();

  assert.equal(renders.current.length, 1);
  assert.deepEqual(renders.current[0], {
    enabled: false,
    description: "",
    repoFilter: [],
  });

  await unmount();
});

test("toggling provider advertising on/off repeatedly never crashes and stays in sync", async () => {
  setProviderCapabilitySettings("agent-a", {
    enabled: false,
    description: "quotes TS refactors",
    repoFilter: [],
  });

  const { render, renders, unmount } = mountHook("agent-a");
  await render();

  for (let i = 0; i < 5; i++) {
    const enabled = i % 2 === 0;
    await act(async () => {
      setProviderCapabilitySettings("agent-a", {
        enabled,
        description: "quotes TS refactors",
        repoFilter: [],
      });
    });
    const latest = renders.current[renders.current.length - 1];
    assert.equal(
      latest.enabled,
      enabled,
      `hook must reflect toggle ${i} (enabled=${enabled})`,
    );
  }

  await unmount();
});

test("the cached snapshot is referentially stable between writes, and changes on write", () => {
  setProviderCapabilitySettings("agent-a", {
    enabled: true,
    description: "x",
    repoFilter: [],
  });

  const first = getProviderCapabilitySettingsSnapshot("agent-a");
  const second = getProviderCapabilitySettingsSnapshot("agent-a");
  assert.equal(first, second, "unchanged reads must return the same object");

  setProviderCapabilitySettings("agent-a", {
    enabled: false,
    description: "x",
    repoFilter: [],
  });
  const third = getProviderCapabilitySettingsSnapshot("agent-a");
  assert.notEqual(third, second, "a write must invalidate the cached snapshot");
});
