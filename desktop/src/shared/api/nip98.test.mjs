import assert from "node:assert/strict";
import test from "node:test";

import { nip98GetHeader, nip98PostHeader } from "./nip98.ts";

const URL_UNDER_TEST = "http://127.0.0.1:8788/search?q=deploy";

// `signRelayEvent` goes through @tauri-apps/api/core's `invoke`, which calls
// `window.__TAURI_INTERNALS__.invoke` — mirrors invites.test.mjs's stub. The
// stub echoes the event it was asked to sign, so a test can read the tags the
// signature would have covered.
function setupTauriStubs() {
  globalThis.window = globalThis.window ?? {};
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "sign_event") {
        return JSON.stringify({ ...args, id: "x", sig: "y", pubkey: "z" });
      }
      throw new Error(`Unexpected Tauri command: ${command}`);
    },
  };
}

function teardownTauriStubs() {
  delete globalThis.window.__TAURI_INTERNALS__;
}

/** `Nostr <base64>` back into the event the header carries. */
function decodeHeader(header) {
  assert.match(header, /^Nostr /);
  return JSON.parse(atob(header.slice("Nostr ".length)));
}

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

test("a GET header signs the exact url and method, with a nonce and no payload", async () => {
  setupTauriStubs();
  try {
    const event = decodeHeader(await nip98GetHeader(URL_UNDER_TEST));

    assert.equal(event.kind, 27235);
    assert.equal(event.content, "");
    assert.equal(tagValue(event, "u"), URL_UNDER_TEST);
    assert.equal(tagValue(event, "method"), "GET");
    assert.equal(tagValue(event, "payload"), undefined);
    assert.notEqual(tagValue(event, "nonce"), undefined);
  } finally {
    teardownTauriStubs();
  }
});

test("a POST header carries sha256 of the body, so a swapped body cannot verify", async () => {
  setupTauriStubs();
  try {
    const body = JSON.stringify({ q: "deploy", channels: ["eng"] });
    const event = decodeHeader(await nip98PostHeader(URL_UNDER_TEST, body));

    assert.equal(tagValue(event, "u"), URL_UNDER_TEST);
    assert.equal(tagValue(event, "method"), "POST");

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert.equal(tagValue(event, "payload"), expected);
  } finally {
    teardownTauriStubs();
  }
});

test("each header carries a fresh nonce", async () => {
  setupTauriStubs();
  try {
    const first = decodeHeader(await nip98GetHeader(URL_UNDER_TEST));
    const second = decodeHeader(await nip98GetHeader(URL_UNDER_TEST));
    assert.notEqual(tagValue(first, "nonce"), tagValue(second, "nonce"));
  } finally {
    teardownTauriStubs();
  }
});
