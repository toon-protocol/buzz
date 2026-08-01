import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  CHANNEL_MEDIA_SCHEME,
  decryptChannelMedia,
  decryptChannelMediaWithKey,
  deriveBlobKey,
  encryptChannelMedia,
  isSealedMediaEnvelope,
  mediaSha256,
} from "./channelMediaCrypto.ts";
import { channelKeyId } from "./channelEncryption.ts";
import {
  adoptChannelKey,
  setChannelKey,
  setChannelKeyStorage,
} from "./channelKeyStore.ts";

globalThis.crypto ??= webcrypto;

const CHANNEL = "11111111-2222-3333-4444-555555555555";

/** A deterministic 32-byte key, so a failure reproduces. */
function key(seed) {
  return new Uint8Array(32).fill(seed);
}

/** Something big enough that NIP-44's 64 KiB plaintext ceiling would refuse it. */
function bigFile() {
  const bytes = new Uint8Array(200_000);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = index % 251;
  return bytes;
}

function freshStore() {
  const values = new Map();
  setChannelKeyStorage({
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
  });
}

test("a member round-trips a file larger than NIP-44 could carry", async () => {
  // The reason this module exists rather than reusing `encryptChannelContent`:
  // NIP-44 v2 refuses anything over 65535 bytes, and files are bigger.
  const plaintext = bigFile();
  const channelKey = key(7);

  const { ciphertext, envelope } = await encryptChannelMedia(
    plaintext,
    channelKey,
    { mime: "image/png", dim: "800x600", filename: "chart.png" },
  );

  const opened = await decryptChannelMediaWithKey(
    ciphertext,
    envelope,
    channelKey,
  );
  assert.deepEqual(opened, plaintext);
});

test("the ciphertext is not the plaintext, and carries the whole file", async () => {
  const plaintext = new Uint8Array(4096).fill(0x41);
  const { ciphertext } = await encryptChannelMedia(plaintext, key(3), {
    mime: "text/plain",
  });

  assert.notDeepEqual(ciphertext.slice(0, plaintext.length), plaintext);
  // GCM appends a 16-byte tag; nothing else is added, so a raw gateway fetch
  // reveals only the length, which is what the design says it reveals.
  assert.equal(ciphertext.byteLength, plaintext.byteLength + 16);
  // No run of the plaintext survives — the point of the whole exercise.
  assert.equal(
    ciphertext.includes(0x41) && ciphertext.every((b) => b === 0x41),
    false,
  );
});

test("the envelope describes the plaintext and hashes the ciphertext", async () => {
  const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
  const channelKey = key(9);
  const { ciphertext, envelope } = await encryptChannelMedia(
    plaintext,
    channelKey,
    { mime: "image/gif", dim: "1x1", filename: "a.gif" },
  );

  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, CHANNEL_MEDIA_SCHEME);
  assert.equal(envelope.keyId, channelKeyId(channelKey));
  assert.equal(envelope.mime, "image/gif");
  assert.equal(envelope.size, plaintext.byteLength);
  assert.equal(envelope.dim, "1x1");
  assert.equal(envelope.filename, "a.gif");
  // The tombstone tag names this value, so it has to be the ciphertext's hash
  // and not the plaintext's — otherwise the `x` tag is a confirmation oracle.
  assert.equal(envelope.sha256, mediaSha256(ciphertext));
  assert.notEqual(envelope.sha256, mediaSha256(plaintext));
  assert.ok(isSealedMediaEnvelope(envelope));
});

test("every blob gets its own salt, iv, and therefore its own key", async () => {
  const channelKey = key(4);
  const plaintext = new Uint8Array([9, 9, 9]);
  const first = await encryptChannelMedia(plaintext, channelKey, {
    mime: "application/octet-stream",
  });
  const second = await encryptChannelMedia(plaintext, channelKey, {
    mime: "application/octet-stream",
  });

  assert.notEqual(first.envelope.salt, second.envelope.salt);
  assert.notEqual(first.envelope.iv, second.envelope.iv);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
});

test("the blob key is derived from the channel key, never carried", async () => {
  // Same channel key + same salt => same bytes; a different channel key with
  // the same salt => different bytes. That is what makes "holds the channel
  // key" and "can open the file" the same statement (ADR 0002).
  const salt = new Uint8Array(32).fill(1);
  assert.deepEqual(deriveBlobKey(key(1), salt), deriveBlobKey(key(1), salt));
  assert.notDeepEqual(deriveBlobKey(key(1), salt), deriveBlobKey(key(2), salt));

  const { envelope } = await encryptChannelMedia(new Uint8Array([1]), key(1), {
    mime: "image/png",
  });
  // Nothing in the envelope is, or wraps, key material.
  assert.equal(JSON.stringify(envelope).includes("0101010101010101"), false);
});

test("a non-member cannot open the blob", async () => {
  const plaintext = new Uint8Array([1, 2, 3]);
  const { ciphertext, envelope } = await encryptChannelMedia(
    plaintext,
    key(5),
    { mime: "image/png" },
  );

  // Not a throw: on an open relay, failing to decrypt someone else's channel
  // is the ordinary case.
  assert.equal(
    await decryptChannelMediaWithKey(ciphertext, envelope, key(6)),
    null,
  );
});

test("a tampered ciphertext does not open", async () => {
  const channelKey = key(8);
  const { ciphertext, envelope } = await encryptChannelMedia(
    new Uint8Array([1, 2, 3, 4]),
    channelKey,
    { mime: "image/png" },
  );
  ciphertext[0] ^= 0xff;
  assert.equal(
    await decryptChannelMediaWithKey(ciphertext, envelope, channelKey),
    null,
  );
});

test("an unknown scheme is refused rather than guessed at", async () => {
  const channelKey = key(2);
  const { ciphertext, envelope } = await encryptChannelMedia(
    new Uint8Array([1]),
    channelKey,
    { mime: "image/png" },
  );
  assert.equal(
    await decryptChannelMediaWithKey(
      ciphertext,
      { ...envelope, alg: "some-future-thing/v9" },
      channelKey,
    ),
    null,
  );
});

test("the ring resolves the epoch the envelope names", async () => {
  freshStore();
  const oldKey = key(10);
  const newKey = key(11);
  setChannelKey(CHANNEL, oldKey);

  const before = await encryptChannelMedia(new Uint8Array([1, 2]), oldKey, {
    mime: "image/png",
  });

  // Rotation: the new key becomes the sending key, the old one stays for
  // reading history (`channelKeyStore`, buzz#18).
  setChannelKey(CHANNEL, newKey);
  adoptChannelKey(CHANNEL, oldKey);
  const after = await encryptChannelMedia(new Uint8Array([3, 4]), newKey, {
    mime: "image/png",
  });

  assert.deepEqual(
    await decryptChannelMedia(before.ciphertext, before.envelope, CHANNEL),
    new Uint8Array([1, 2]),
  );
  assert.deepEqual(
    await decryptChannelMedia(after.ciphertext, after.envelope, CHANNEL),
    new Uint8Array([3, 4]),
  );
});

test("a removed member cannot open post-rotation media", async () => {
  // The property rotation exists for, extended to media: the removed member
  // keeps the epoch they were in and gets nothing after it. This is only true
  // because the blob key derives from the channel key — a wrapped per-file key
  // would have handed them the file regardless.
  const oldKey = key(12);
  const newKey = key(13);

  const history = await encryptChannelMedia(new Uint8Array([1]), oldKey, {
    mime: "image/png",
  });
  const afterRemoval = await encryptChannelMedia(new Uint8Array([2]), newKey, {
    mime: "image/png",
  });

  // The removed member's ring: the old key only.
  freshStore();
  setChannelKey(CHANNEL, oldKey);

  assert.deepEqual(
    await decryptChannelMedia(history.ciphertext, history.envelope, CHANNEL),
    new Uint8Array([1]),
    "history they already had stays readable (ADR 0002)",
  );
  assert.equal(
    await decryptChannelMedia(
      afterRemoval.ciphertext,
      afterRemoval.envelope,
      CHANNEL,
    ),
    null,
    "post-rotation media never opens for them again",
  );
});

test("a client with no key for the channel opens nothing", async () => {
  freshStore();
  const { ciphertext, envelope } = await encryptChannelMedia(
    new Uint8Array([1]),
    key(14),
    { mime: "image/png" },
  );
  assert.equal(
    await decryptChannelMedia(ciphertext, envelope, "some-other-channel"),
    null,
  );
});

test("malformed envelopes are rejected, not trusted", () => {
  const good = {
    v: 1,
    alg: CHANNEL_MEDIA_SCHEME,
    keyId: "abcdef0123456789",
    salt: "a".repeat(64),
    iv: "b".repeat(24),
    mime: "image/png",
    size: 10,
    sha256: "c".repeat(64),
  };
  assert.ok(isSealedMediaEnvelope(good));

  assert.equal(isSealedMediaEnvelope(null), false);
  assert.equal(isSealedMediaEnvelope("nope"), false);
  assert.equal(isSealedMediaEnvelope({ ...good, v: 2 }), false);
  assert.equal(isSealedMediaEnvelope({ ...good, salt: "short" }), false);
  assert.equal(isSealedMediaEnvelope({ ...good, iv: "zz".repeat(12) }), false);
  assert.equal(isSealedMediaEnvelope({ ...good, size: "10" }), false);
  assert.equal(
    isSealedMediaEnvelope({ ...good, sha256: "a".repeat(63) }),
    false,
  );
});
