/**
 * Regression tests for buzz#190 — a stale-closure in-flight guard in
 * `useProviderDelivery.deliverNext` (`phase.kind !== "idle"`) let two
 * invocations in one synchronous tick both pass, and let a mid-payment
 * unmount/remount cycle re-arm the delivery port over a still-live offer.
 * Both failure modes overwrite the port's armed key, stranding the
 * outstanding offer's payment release. This mounts the REAL production hook
 * against a scripted transport whose `waitForPayment` is caller-controlled,
 * so the payment wait can be held open across an unmount/remount.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
// Mirrors the shim used by useProviderCapabilitySettings.test.mjs /
// MessageComposerDraftImagePersist.test.mjs — react-dom/client needs a small
// subset of the DOM API and nothing here renders real markup.

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

import { useProviderDelivery } from "./useProviderDelivery.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

const JOB = {
  eventId: "job-190",
  buyerPubkey: "b".repeat(64),
  createdAt: 1_700_000_000,
  brief: "Refactor the auth module",
  bidBaseUnits: 5_000_000n,
  repo: "toon-protocol/buzz",
  target: null,
  constraints: null,
  outputMimeType: null,
  targetProviderPubkey: null,
  alreadyQuoted: true,
  giftWrapped: false,
  requestEvent: {
    id: "job-190",
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 5097,
    content: "",
    tags: [],
    sig: "e".repeat(128),
  },
};

const QUOTE = {
  eventId: "quote-190",
  providerPubkey: "p".repeat(64),
  createdAt: 1_700_000_001,
  rootJobId: "job-190",
  status: "quote",
  increments: [
    { n: 1, of: 2, milestone: "Plan", priceUsdcBaseUnits: 1_000_000n },
    { n: 2, of: 2, milestone: "Implement", priceUsdcBaseUnits: 2_000_000n },
  ],
};

/** Echo the template back as a "signed" event, like the real Tauri command. */
function setupTauriStub() {
  let counter = 0;
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command !== "sign_event") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }
      counter += 1;
      return JSON.stringify({
        id: `signed-${counter}`,
        pubkey: "p".repeat(64),
        created_at: args.createdAt,
        kind: args.kind,
        content: args.content,
        tags: args.tags,
        sig: "s".repeat(128),
      });
    },
  };
}

function teardownTauriStub() {
  delete globalThis.window.__TAURI_INTERNALS__;
}

/**
 * A scripted delivery port + writer + transport, recording every step.
 * `waitForPayment` is caller-controlled via `resolvers` so a test can hold
 * the payment wait open across a simulated unmount/remount.
 */
function scriptedTransport() {
  const log = [];
  const resolvers = [];
  const port = {
    async encryptArtifact(bytes) {
      log.push({ step: "encrypt", plaintext: new TextDecoder().decode(bytes) });
      return {
        ciphertext: new TextEncoder().encode("CIPHERTEXT"),
        ciphertextSha256: "ab".repeat(32),
        conditionHex: "cd".repeat(32),
      };
    },
    async waitForPayment(offer) {
      log.push({ step: "wait", offer });
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  const writer = {
    async getJobDeliveryPort() {
      return port;
    },
    async uploadBlob(blobData, contentType) {
      log.push({
        step: "upload",
        bytes: new TextDecoder().decode(blobData),
        contentType,
      });
      return { txId: "tx-cipher", receipt: {} };
    },
  };
  const transport = {
    getPaidWriter: () => writer,
    async publish(event) {
      log.push({ step: "publish", event });
      return event;
    },
  };
  return { transport, log, resolvers };
}

/** Mount `useProviderDelivery` in a real React tree. */
function mountDeliveryHook({ transport, job, quote, wireOffers }) {
  const renders = { current: [] };

  function HarnessComponent() {
    const delivery = useProviderDelivery({ transport, job, quote, wireOffers });
    renders.current.push(delivery);
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
  setupTauriStub();
});

test.afterEach(() => {
  teardownTauriStub();
});

test("deliverNext double-invocation in the same tick starts only one delivery (buzz#190 item 1)", async () => {
  const { transport, log, resolvers } = scriptedTransport();
  const { render, renders, unmount } = mountDeliveryHook({
    transport,
    job: JOB,
    quote: QUOTE,
    wireOffers: [],
  });
  await render();

  const delivery = renders.current.at(-1);

  // Two invocations in one synchronous tick — the Enter+click race from the
  // issue. Both read the same "idle" closure before either `setPhase` has
  // committed. Neither is awaited here: the second call's guard must trip
  // synchronously, before the first call's `waitForPayment` (which this
  // test controls and has not resolved yet) could ever settle either one.
  let p1;
  let p2;
  await act(async () => {
    p1 = delivery.deliverNext("increment 1 artifact");
    p2 = delivery.deliverNext("increment 1 artifact");
    // Flush microtasks so both calls run to their first real await.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(
    log.filter((entry) => entry.step === "encrypt").length,
    1,
    "only one delivery should have started encrypting the artifact",
  );
  assert.equal(
    log.filter((entry) => entry.step === "publish").length,
    1,
    "only one offer should have published — a second would overwrite the port's armed key",
  );
  assert.equal(resolvers.length, 1, "only one waitForPayment should be armed");

  resolvers[0](true);
  await act(async () => {
    await Promise.all([p1, p2]);
  });
  await unmount();
});

test("a remount mid-awaiting-payment does not re-arm the port over the live offer (buzz#190 item 2)", async () => {
  const { transport, log, resolvers } = scriptedTransport();

  // Mount A: start delivering increment 1 and let it reach awaiting-payment.
  const a = mountDeliveryHook({
    transport,
    job: JOB,
    quote: QUOTE,
    wireOffers: [],
  });
  await a.render();
  const deliveryA = a.renders.current.at(-1);

  let deliverPromiseA;
  await act(async () => {
    deliverPromiseA = deliveryA.deliverNext("increment 1 artifact");
    // Flush microtasks so the offer publishes and waitForPayment arms —
    // deliverNext then parks on the still-unresolved payment promise.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(
    log.filter((entry) => entry.step === "publish").length,
    1,
    "increment 1's offer should have published",
  );
  assert.equal(resolvers.length, 1, "the port should be armed for increment 1");

  // Collapse the panel mid-payment (React state resets; the port stays armed).
  await a.unmount();

  // Reopen it. The relay read-back for the increment-1 offer hasn't landed
  // yet (wireOffers still empty), so a fresh mount computes the same "next
  // increment" the still-outstanding offer already claimed.
  const b = mountDeliveryHook({
    transport,
    job: JOB,
    quote: QUOTE,
    wireOffers: [],
  });
  await b.render();
  const deliveryB = b.renders.current.at(-1);

  await act(async () => {
    await deliveryB.deliverNext("increment 1 artifact, again");
  });

  assert.equal(
    log.filter((entry) => entry.step === "encrypt").length,
    1,
    "the remount must not start a second delivery for the same increment",
  );
  assert.equal(
    log.filter((entry) => entry.step === "publish").length,
    1,
    "the remount must not publish a second offer, which would overwrite the port's armed key",
  );
  assert.equal(
    resolvers.length,
    1,
    "the remount must not re-arm the port — the original offer's key must stay releasable",
  );

  // The original, still-outstanding payment now resolves — the system must
  // settle cleanly even though the mount that started it is long gone.
  resolvers[0](true);
  await act(async () => {
    await deliverPromiseA;
  });

  await b.unmount();
});
