import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  channelKeyId,
  formatChannelKey,
  generateChannelKey,
  parseChannelKey,
} from "./channelEncryption.ts";
import { setChannelKey, setChannelKeyStorage } from "./channelKeyStore.ts";
import {
  ENCRYPTION_TAG,
  LOCKED_MESSAGE_PLACEHOLDER,
  NIP44_V2_SCHEME,
  openChannelEvent,
  openChannelEvents,
  readChannelTag,
  readEncryptionTag,
  sealChannelContent,
} from "./channelMessageCrypto.ts";

const CHANNEL = "engineering";
const CHANNEL_KEY = parseChannelKey("d".repeat(64));

/** A disk that outlives the store's cache, the way a real one outlives a run. */
function fakeDisk(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

/**
 * The event `eventWrites.sendStreamMessage` builds and signs, minus the
 * signing. Kept in this shape so the layout under test is the layout that
 * actually goes on the wire.
 */
function publishMessage(channelId, content, mentionPubkeys = []) {
  const sealed = sealChannelContent(channelId, content);
  return {
    id: "e".repeat(64),
    pubkey: "f".repeat(64),
    created_at: 1_700_000_000,
    kind: 9,
    tags: [
      ["h", channelId],
      ...sealed.tags,
      ...mentionPubkeys.map((pubkey) => ["p", pubkey]),
    ],
    content: sealed.content,
    sig: "0".repeat(128),
  };
}

let disk;

beforeEach(() => {
  disk = fakeDisk();
  setChannelKeyStorage(disk);
});

test("a channel with no key posts in the clear", () => {
  const event = publishMessage(CHANNEL, "public roadmap update");

  assert.equal(event.content, "public roadmap update");
  assert.equal(readEncryptionTag(event.tags), null);
  // And a reader treats it as the plain event it is — same object, so React
  // caches are not invalidated by events that changed nothing.
  assert.equal(openChannelEvent(event), event);
});

test("a keyed channel seals content and declares the scheme and key", () => {
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const event = publishMessage(CHANNEL, "rotate the deploy token today");

  assert.ok(!event.content.includes("deploy token"));
  assert.deepEqual(readEncryptionTag(event.tags), {
    scheme: NIP44_V2_SCHEME,
    keyId: channelKeyId(CHANNEL_KEY),
  });
  assert.equal(readChannelTag(event.tags), CHANNEL);
});

test("routing tags stay in the clear; the message does not", () => {
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const event = publishMessage(CHANNEL, "secret words", ["a".repeat(64)]);

  // ADR 0001: the relay learns the shape of the traffic, never its substance.
  const flatTags = JSON.stringify(event.tags);
  assert.ok(flatTags.includes(CHANNEL));
  assert.ok(flatTags.includes("a".repeat(64)));
  assert.ok(!flatTags.includes("secret words"));
  assert.ok(!event.content.includes("secret words"));
  // The key itself never appears anywhere on the wire.
  assert.ok(
    !`${flatTags}${event.content}`.includes(formatChannelKey(CHANNEL_KEY)),
  );
});

test("the second client, holding the same key, reads the message", () => {
  // Alice seals.
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const onTheWire = publishMessage(CHANNEL, "standup moved to 10:30");

  // Bob is a different client with the same manually-shared key.
  setChannelKeyStorage(fakeDisk());
  setChannelKey(CHANNEL, CHANNEL_KEY);

  const opened = openChannelEvent(onTheWire);
  assert.equal(opened.content, "standup moved to 10:30");
  assert.equal(opened.encryption.opened, true);
  assert.equal(opened.encryption.keyId, channelKeyId(CHANNEL_KEY));
  // The ciphertext is kept: `content` is no longer what the signature covers.
  assert.equal(opened.encryption.payload, onTheWire.content);
});

test("a non-member sees ciphertext, never the message", () => {
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const onTheWire = publishMessage(CHANNEL, "standup moved to 10:30");

  // Carol subscribes to the same relay with no key at all.
  setChannelKeyStorage(fakeDisk());

  const opened = openChannelEvent(onTheWire);
  assert.equal(opened.content, LOCKED_MESSAGE_PLACEHOLDER);
  assert.equal(opened.encryption.opened, false);
  assert.ok(!JSON.stringify(opened).includes("standup moved"));
  // Opening must not have edited the event Carol received.
  assert.notEqual(onTheWire.content, LOCKED_MESSAGE_PLACEHOLDER);
});

test("the wrong key is handled exactly like no key", () => {
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const onTheWire = publishMessage(CHANNEL, "standup moved to 10:30");

  setChannelKeyStorage(fakeDisk());
  setChannelKey(CHANNEL, generateChannelKey());

  const opened = openChannelEvent(onTheWire);
  assert.equal(opened.content, LOCKED_MESSAGE_PLACEHOLDER);
  assert.equal(opened.encryption.opened, false);
});

test("a key for another channel does not open this one", () => {
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const onTheWire = publishMessage(CHANNEL, "engineering only");

  setChannelKeyStorage(fakeDisk());
  setChannelKey("design", CHANNEL_KEY);

  assert.equal(openChannelEvent(onTheWire).content, LOCKED_MESSAGE_PLACEHOLDER);
});

test("an unknown sealing scheme locks rather than guesses", () => {
  const event = {
    ...publishMessage(CHANNEL, "sealed by a future client"),
    tags: [
      ["h", CHANNEL],
      [ENCRYPTION_TAG, "nip44-v3", "0123456789abcdef"],
    ],
  };

  setChannelKey(CHANNEL, CHANNEL_KEY);
  const opened = openChannelEvent(event);

  assert.equal(opened.content, LOCKED_MESSAGE_PLACEHOLDER);
  assert.equal(opened.encryption.scheme, "nip44-v3");
});

test("an encrypted event with no channel tag locks", () => {
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const event = {
    ...publishMessage(CHANNEL, "orphaned"),
    tags: [[ENCRYPTION_TAG, NIP44_V2_SCHEME, channelKeyId(CHANNEL_KEY)]],
  };

  assert.equal(openChannelEvent(event).content, LOCKED_MESSAGE_PLACEHOLDER);
});

test("history written before the last launch still opens after a restart", () => {
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const history = [
    publishMessage(CHANNEL, "first"),
    publishMessage(CHANNEL, "second"),
    publishMessage(CHANNEL, "third"),
  ];

  // The app closes and reopens: same disk, no in-memory cache.
  setChannelKeyStorage(disk);

  assert.deepEqual(
    openChannelEvents(history).map((event) => event.content),
    ["first", "second", "third"],
  );
});

test("the sender's own echo is plaintext, not its own ciphertext", () => {
  // `sendStreamMessage` returns the published event through the same opener,
  // so the composer does not paint the timeline with base64.
  setChannelKey(CHANNEL, CHANNEL_KEY);
  const published = publishMessage(CHANNEL, "shipping it");

  assert.equal(openChannelEvent(published).content, "shipping it");
});

test("an explicit key overrides the store, for callers that hold one", () => {
  const key = generateChannelKey();
  const sealed = sealChannelContent(CHANNEL, "explicit", key);
  const event = {
    ...publishMessage(CHANNEL, "ignored"),
    content: sealed.content,
    tags: [["h", CHANNEL], ...sealed.tags],
  };

  assert.equal(openChannelEvent(event, key).content, "explicit");
});
