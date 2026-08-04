import assert from "node:assert/strict";
import test from "node:test";

import { postFactoryJobQuote } from "./postFactoryJobQuote.ts";

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

test("signs the quote template and publishes it on the transport", async () => {
  const signedEvent = {
    id: "quote-id",
    pubkey: "provider",
    created_at: 1,
    kind: 7000,
    content: "signed-content",
    tags: [["status", "quote"]],
    sig: "sig",
  };
  const calls = setupTauriStub(signedEvent);
  const published = [];

  try {
    const result = await postFactoryJobQuote(
      {
        rootJobId: "job-1",
        increments: [{ milestone: "plan", priceUsdcBaseUnits: 1_000_000n }],
      },
      /** @type {any} */ ({
        publish: (event) => {
          published.push(event);
          return Promise.resolve(event);
        },
      }),
    );

    assert.equal(result.id, "quote-id");
    assert.equal(published.length, 1);
    assert.equal(published[0].id, "quote-id");
    const signArgs = calls.find((call) => call.command === "sign_event").args;
    assert.equal(signArgs.kind, 7000);
    assert.deepEqual(signArgs.tags, [
      ["status", "quote"],
      ["e", "job-1", "", "root"],
    ]);
  } finally {
    teardownTauriStub();
  }
});

test("an invalid quote (no increments) never reaches signing or publish", async () => {
  setupTauriStub({});
  try {
    await assert.rejects(() =>
      postFactoryJobQuote(
        { rootJobId: "job-1", increments: [] },
        /** @type {any} */ ({
          publish: () => assert.fail("must not publish"),
        }),
      ),
    );
  } finally {
    teardownTauriStub();
  }
});
