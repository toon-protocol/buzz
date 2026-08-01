import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { parseChannelKey } from "./channelEncryption.ts";
import { setChannelKey, setChannelKeyStorage } from "./channelKeyStore.ts";
import { sealChannelContent } from "./channelMessageCrypto.ts";
import {
  resetEventTransport,
  setEventTransport,
  subscribeLiveEvents,
} from "./eventTransport.ts";

const CHANNEL = "engineering";
const CHANNEL_KEY = parseChannelKey("9".repeat(64));

function memoryDisk() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

/** A transport that carries nothing anywhere — only what the seam does matters. */
function stubTransport() {
  let deliver = null;
  return {
    ready: async () => {},
    isWritable: () => true,
    publish: async (event) => event,
    publishEphemeral: async () => {},
    subscribeLive: async (_filter, onEvent) => {
      deliver = onEvent;
      return async () => {};
    },
    emit: (event) => deliver?.(event),
  };
}

beforeEach(() => {
  setChannelKeyStorage(memoryDisk());
});

afterEach(() => {
  resetEventTransport();
});

test("the seam decrypts inbound events whatever transport carried them", async () => {
  // The placement claim in `channelMessageCrypto.ts`, asserted: a transport
  // that knows nothing about encryption still yields plaintext, so privacy
  // cannot come to depend on `BUZZ_TRANSPORT`.
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const transport = stubTransport();
  setEventTransport(transport);

  const received = [];
  await subscribeLiveEvents({ kinds: [9] }, (event) => received.push(event));

  const sealed = sealChannelContent(CHANNEL, "deploy at 16:00");
  transport.emit({
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 9,
    tags: [["h", CHANNEL], ...sealed.tags],
    content: sealed.content,
    sig: "0".repeat(128),
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].content, "deploy at 16:00");
  assert.equal(received[0].encryption.opened, true);
});

test("the seam passes unencrypted events through untouched", async () => {
  const transport = stubTransport();
  setEventTransport(transport);

  const received = [];
  await subscribeLiveEvents({ kinds: [9] }, (event) => received.push(event));

  const plain = {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 9,
    tags: [["h", "general"]],
    content: "morning",
    sig: "0".repeat(128),
  };
  transport.emit(plain);

  assert.equal(received[0], plain);
});
