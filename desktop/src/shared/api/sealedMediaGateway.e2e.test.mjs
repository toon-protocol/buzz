import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import { decryptChannelMediaWithKey } from "./channelMediaCrypto.ts";
import { parseChannelKey } from "./channelEncryption.ts";
import { fetchSealedMediaBytes } from "./sealedMediaStore.ts";

globalThis.crypto ??= webcrypto;

/**
 * The live half of buzz#17's acceptance criteria, against a real gateway.
 *
 * Everything else about sealed media is provable offline — the uploader tests
 * pin the encrypt-before-upload invariant, and `sealedMediaStore.test.mjs`
 * drives fetch → decrypt with the real AEAD and the real key ring. What they
 * cannot prove is the claim the whole feature makes to a user: *the bytes
 * sitting on Arweave right now are unreadable*. That needs a transaction id
 * from an actual paid upload, so it is gated on one being supplied rather than
 * skipped silently or faked with a fixture.
 *
 * Run it against a blob you uploaded from a keyed channel:
 *
 * ```
 * BUZZ_SEALED_MEDIA_TX=<arweave tx id> \
 * BUZZ_SEALED_MEDIA_KEY=<64 hex chars, the channel key> \
 * BUZZ_SEALED_MEDIA_ENVELOPE='<the envelope JSON from the message content>' \
 *   pnpm test
 * ```
 *
 * The envelope comes out of the sealed message's `<!--buzz:media/v1 …-->`
 * record, which is what a member's client reads it from.
 */

const TX_ID = process.env.BUZZ_SEALED_MEDIA_TX;
const KEY_HEX = process.env.BUZZ_SEALED_MEDIA_KEY;
const ENVELOPE_JSON = process.env.BUZZ_SEALED_MEDIA_ENVELOPE;

const configured = Boolean(TX_ID && KEY_HEX && ENVELOPE_JSON);

test("a raw gateway fetch of private media returns ciphertext that the channel key opens", {
  skip: configured ? false : "set BUZZ_SEALED_MEDIA_TX/_KEY/_ENVELOPE",
}, async () => {
  const envelope = JSON.parse(ENVELOPE_JSON);
  const key = parseChannelKey(KEY_HEX);
  assert.notEqual(key, null, "BUZZ_SEALED_MEDIA_KEY must be 32 bytes of hex");

  const ciphertext = await fetchSealedMediaBytes(
    `https://arweave.net/${TX_ID}`,
  );
  assert.notEqual(ciphertext, null, "no gateway served the transaction");

  // What a non-member sees: opaque, and not a file any renderer recognises.
  assert.equal(ciphertext.byteLength, envelope.size + 16);
  assert.notDeepEqual([...ciphertext.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.notDeepEqual([...ciphertext.slice(0, 3)], [0xff, 0xd8, 0xff]);

  // What a member sees: the file, byte for byte.
  const plaintext = await decryptChannelMediaWithKey(ciphertext, envelope, key);
  assert.notEqual(plaintext, null, "the channel key did not open the blob");
  assert.equal(plaintext.byteLength, envelope.size);

  // And the wrong key still does not, against bytes that are really on the
  // permaweb rather than ones this test just produced.
  assert.equal(
    await decryptChannelMediaWithKey(
      ciphertext,
      envelope,
      new Uint8Array(32).fill(0),
    ),
    null,
  );
});
