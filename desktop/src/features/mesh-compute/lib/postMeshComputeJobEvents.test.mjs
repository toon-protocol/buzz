import assert from "node:assert/strict";
import test from "node:test";

import {
  publishMeshComputeAccepted,
  publishMeshComputeCompletedOffer,
  publishMeshComputeJobResult,
  publishMeshComputeRefused,
} from "./postMeshComputeJobEvents.ts";

function setupTauriStub(signedEvent) {
  const calls = [];
  globalThis.window = globalThis.window ?? {};
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "sign_event") return JSON.stringify(signedEvent);
      throw new Error(`Unexpected Tauri command: ${command}`);
    },
  };
  return calls;
}

function teardownTauriStub() {
  delete globalThis.window.__TAURI_INTERNALS__;
}

function fakeTransport(published) {
  return /** @type {any} */ ({
    publish: (event) => {
      published.push(event);
      return Promise.resolve(event);
    },
  });
}

test("publishes a signed accepted event", async () => {
  const signedEvent = {
    id: "accepted-id",
    pubkey: "seller",
    created_at: 1,
    kind: 7000,
    content: "",
    tags: [["status", "accepted"]],
    sig: "sig",
  };
  const calls = setupTauriStub(signedEvent);
  const published = [];
  try {
    const result = await publishMeshComputeAccepted(
      { rootJobId: "job-1", buyerPubkey: "buyer-1" },
      fakeTransport(published),
    );
    assert.equal(result.id, "accepted-id");
    assert.equal(published.length, 1);
    const signArgs = calls.find((call) => call.command === "sign_event").args;
    assert.equal(signArgs.kind, 7000);
    assert.deepEqual(signArgs.tags, [
      ["status", "accepted"],
      ["e", "job-1", "", "root"],
      ["p", "buyer-1"],
    ]);
  } finally {
    teardownTauriStub();
  }
});

test("publishes a signed refused event with a reason tag", async () => {
  const signedEvent = {
    id: "refused-id",
    pubkey: "seller",
    created_at: 1,
    kind: 7000,
    content: "",
    tags: [["status", "refused"]],
    sig: "sig",
  };
  setupTauriStub(signedEvent);
  const published = [];
  try {
    const result = await publishMeshComputeRefused(
      {
        rootJobId: "job-1",
        buyerPubkey: "buyer-1",
        reason: "context-exceeded",
      },
      fakeTransport(published),
    );
    assert.equal(result.id, "refused-id");
    assert.equal(published.length, 1);
  } finally {
    teardownTauriStub();
  }
});

test("publishes a signed completed-offer carrying the ciphertext and condition", async () => {
  const signedEvent = {
    id: "offer-id",
    pubkey: "seller",
    created_at: 1,
    kind: 7000,
    content: "Q0lQSEVSVEVYVA==",
    tags: [["status", "completed-offer"]],
    sig: "sig",
  };
  const calls = setupTauriStub(signedEvent);
  const published = [];
  try {
    const result = await publishMeshComputeCompletedOffer(
      {
        rootJobId: "job-1",
        acceptedEventId: "accepted-1",
        buyerPubkey: "buyer-1",
        amountMicroUsdc: 4_000n,
        conditionHex: "ab".repeat(32),
        ciphertextBase64: "Q0lQSEVSVEVYVA==",
      },
      fakeTransport(published),
    );
    assert.equal(result.id, "offer-id");
    assert.equal(published.length, 1);
    const signArgs = calls.find((call) => call.command === "sign_event").args;
    assert.equal(signArgs.kind, 7000);
    assert.equal(signArgs.content, "Q0lQSEVSVEVYVA==");
    assert.deepEqual(signArgs.tags, [
      ["status", "completed-offer"],
      ["e", "job-1", "", "root"],
      ["e", "accepted-1", "", "reply"],
      ["p", "buyer-1"],
      ["amount", "4000", "usdc"],
      ["condition", "ab".repeat(32)],
    ]);
  } finally {
    teardownTauriStub();
  }
});

test("publishes a signed refused kind:6098 result", async () => {
  const signedEvent = {
    id: "result-id",
    pubkey: "seller",
    created_at: 1,
    kind: 6098,
    content: "",
    tags: [["outcome", "refused"]],
    sig: "sig",
  };
  setupTauriStub(signedEvent);
  const published = [];
  const requestEvent = {
    id: "job-1",
    pubkey: "buyer-1",
    created_at: 1,
    kind: 5098,
    content: "",
    tags: [],
    sig: "sig",
  };
  try {
    const result = await publishMeshComputeJobResult(
      {
        rootJobId: "job-1",
        lastEventId: "refused-id",
        buyerPubkey: "buyer-1",
        requestEvent,
        outcome: "refused",
      },
      fakeTransport(published),
    );
    assert.equal(result.id, "result-id");
    assert.equal(published.length, 1);
  } finally {
    teardownTauriStub();
  }
});

test("an invalid accept (no root job id) never reaches signing or publish", async () => {
  setupTauriStub({});
  try {
    await assert.rejects(() =>
      publishMeshComputeAccepted(
        { rootJobId: "", buyerPubkey: "buyer-1" },
        /** @type {any} */ ({
          publish: () => assert.fail("must not publish"),
        }),
      ),
    );
  } finally {
    teardownTauriStub();
  }
});
