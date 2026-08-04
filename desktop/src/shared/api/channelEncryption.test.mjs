import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_KEY_BYTES,
  channelKeyId,
  decryptChannelContent,
  encryptChannelContent,
  formatChannelKey,
  generateChannelKey,
  parseChannelKey,
} from "./channelEncryption.ts";

const KEY_HEX = "a".repeat(64);

test("a generated key is 32 bytes and round-trips through hex", () => {
  const key = generateChannelKey();
  assert.equal(key.length, CHANNEL_KEY_BYTES);

  const parsed = parseChannelKey(formatChannelKey(key));
  assert.deepEqual(parsed, key);
});

test("two generated keys differ", () => {
  // A constant key would make every "encrypted" channel readable by every
  // client, so this is worth one assertion.
  assert.notEqual(
    formatChannelKey(generateChannelKey()),
    formatChannelKey(generateChannelKey()),
  );
});

test("a pasted key tolerates whitespace, case and an 0x prefix", () => {
  const canonical = parseChannelKey(KEY_HEX);
  assert.deepEqual(parseChannelKey(`  ${KEY_HEX.toUpperCase()}  `), canonical);
  assert.deepEqual(parseChannelKey(`0x${KEY_HEX}`), canonical);
  assert.deepEqual(
    parseChannelKey(`${"a".repeat(32)}\n${"a".repeat(32)}`),
    canonical,
  );
});

test("anything that is not 32 bytes of hex is not a key", () => {
  // A truncated paste must fail here, not silently become a shorter key that
  // fails as "wrong key" three screens later.
  assert.equal(parseChannelKey("a".repeat(63)), null);
  assert.equal(parseChannelKey("a".repeat(65)), null);
  assert.equal(parseChannelKey("z".repeat(64)), null);
  assert.equal(parseChannelKey(""), null);
  assert.equal(parseChannelKey(null), null);
  assert.equal(parseChannelKey(undefined), null);
});

test("content round-trips through the same key", () => {
  const key = generateChannelKey();
  const plaintext = "the standup is moved to 10:30 — bring the migration notes";

  const payload = encryptChannelContent(plaintext, key);
  assert.notEqual(payload, plaintext);
  assert.equal(decryptChannelContent(payload, key), plaintext);
});

test("the ciphertext leaks neither the plaintext nor its length", () => {
  const key = generateChannelKey();
  // Distinctive, 20+ character plaintexts: a base64 payload has ~100+
  // characters drawn from a 64-symbol alphabet, so a short/common substring
  // like "hi" has a real chance (~2%) of appearing by coincidence. A unique
  // string this long does not (buzz#110).
  const plaintextA = "zQ7mK2xR9vL4nP8wT3yB";
  const plaintextB = "hJ5cN0dF6sG1kM9oV2eZ";
  const short = encryptChannelContent(plaintextA, key);
  const alsoShort = encryptChannelContent(plaintextB, key);

  assert.ok(!short.includes(plaintextA));
  // NIP-44 pads to a bucket, so two short messages (both well under the
  // 32-byte first bucket) are the same size on the wire — the property the
  // padding exists for.
  assert.equal(short.length, alsoShort.length);
});

test("the same plaintext encrypts differently every time", () => {
  const key = generateChannelKey();
  assert.notEqual(
    encryptChannelContent("same words", key),
    encryptChannelContent("same words", key),
  );
});

test("a wrong key yields null rather than throwing", () => {
  const payload = encryptChannelContent("members only", generateChannelKey());
  assert.equal(decryptChannelContent(payload, generateChannelKey()), null);
});

test("a payload that is not NIP-44 at all yields null", () => {
  const key = generateChannelKey();
  assert.equal(decryptChannelContent("just a plain message", key), null);
  assert.equal(decryptChannelContent("", key), null);
});

test("a tampered payload fails its MAC", () => {
  const key = generateChannelKey();
  const payload = encryptChannelContent("transfer approved", key);
  const flipped = `${payload.slice(0, -2)}${payload.slice(-2) === "==" ? "AA" : "ZZ"}`;

  assert.equal(decryptChannelContent(flipped, key), null);
});

test("the key id is stable, short, and not the key", () => {
  const key = parseChannelKey(KEY_HEX);
  const id = channelKeyId(key);

  assert.equal(id, channelKeyId(parseChannelKey(KEY_HEX)));
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.ok(!KEY_HEX.includes(id));
  assert.notEqual(id, channelKeyId(generateChannelKey()));
});
