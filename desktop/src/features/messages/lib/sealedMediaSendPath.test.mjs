import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  buildImetaTags,
  buildOutgoingMessage,
  imetaMediaFromTags,
} from "./imetaMediaMarkdown.ts";
import {
  buildMediaTombstoneTags,
  hideTombstonedMedia,
  mediaTombstoneHashes,
} from "./mediaTombstone.ts";
import { encryptChannelMedia } from "@/shared/api/channelMediaCrypto";
import { extractMediaEnvelopes } from "@/shared/api/mediaEnvelopeContent";
import { survivingMediaEnvelopes } from "./sealedMessageMedia.ts";

globalThis.crypto ??= webcrypto;

const CHANNEL = "11111111-2222-3333-4444-555555555555";
const TX_ID = "hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";
const URL_A = `https://arweave.net/${TX_ID}`;

/** What `StoreMediaUploader` hands the composer for a keyed channel. */
async function sealedAttachment() {
  const { ciphertext, envelope } = await encryptChannelMedia(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    new Uint8Array(32).fill(21),
    { mime: "image/png", dim: "12x8", filename: "payroll.png" },
  );
  return {
    ciphertext,
    media: {
      url: URL_A,
      sha256: envelope.sha256,
      size: ciphertext.byteLength,
      type: "application/octet-stream",
      uploaded: 1,
      encryption: envelope,
    },
  };
}

test("the clear-text tags disclose nothing about the plaintext", async () => {
  const { media } = await sealedAttachment();
  const tags = buildImetaTags([media]);
  const flat = tags.flat().join(" ");

  // Tags travel in the clear on an open relay. Everything in them must be a
  // fact about the ciphertext, which is public anyway.
  assert.ok(flat.includes(`url ${URL_A}`));
  assert.ok(flat.includes("m application/octet-stream"));
  assert.ok(flat.includes(`x ${media.encryption.sha256}`));
  assert.equal(flat.includes("payroll"), false);
  assert.equal(flat.includes("image/png"), false);
  assert.equal(flat.includes("dim "), false);
  // And no key material, salt or nonce leaks into a tag either.
  assert.equal(flat.includes(media.encryption.salt), false);
  assert.equal(flat.includes(media.encryption.iv), false);
});

test("the envelope rides in the content, which a keyed channel then seals", async () => {
  const { media } = await sealedAttachment();
  const { content, mediaTags } = buildOutgoingMessage("here it is", [media]);

  // The content is what `sealChannelContent` / Rust's `seal_for_channel`
  // encrypts, so this is the only field on the event that can carry it.
  const extracted = extractMediaEnvelopes(content);
  assert.deepEqual(extracted.envelopes.get(URL_A), media.encryption);
  assert.equal(extracted.body, `here it is\n![image](${URL_A})`);
  assert.equal(mediaTags.length, 1);
});

test("a public attachment produces the same message it always did", async () => {
  // No envelope, no marker: the #14 wire format is untouched for public media.
  const { content } = buildOutgoingMessage("hi", [
    {
      url: URL_A,
      sha256: "a".repeat(64),
      size: 10,
      type: "image/png",
      uploaded: 1,
    },
  ]);
  assert.equal(content, `hi\n![image](${URL_A})`);
});

test("the envelope survives an edit round-trip", async () => {
  // Re-saving an edited message must re-emit the envelope: the bytes are on
  // Arweave forever, and the envelope is the only thing that opens them.
  const { media } = await sealedAttachment();
  const { content, mediaTags } = buildOutgoingMessage("v1", [media]);
  const { envelopes } = extractMediaEnvelopes(content);

  const seeded = imetaMediaFromTags(mediaTags, envelopes);
  assert.deepEqual(seeded[0].encryption, media.encryption);

  const resaved = buildOutgoingMessage("v2", seeded);
  assert.deepEqual(
    extractMediaEnvelopes(resaved.content).envelopes.get(URL_A),
    media.encryption,
  );
});

test("a tombstone hides sealed media exactly as it hides public media", async () => {
  // Parity is the acceptance criterion. It holds because the descriptor's
  // `sha256` is the ciphertext hash on both paths, so the `["x", …]` tag the
  // hide flow builds names the same thing either way.
  const { media } = await sealedAttachment();
  const { content } = buildOutgoingMessage("secret", [media]);
  const tags = buildImetaTags([media]);

  const tombstone = buildMediaTombstoneTags({
    channelId: CHANNEL,
    eventId: "f".repeat(64),
    sha256s: [media.sha256],
  });
  assert.deepEqual(mediaTombstoneHashes(tombstone), [media.encryption.sha256]);

  // Same order the read path uses: lift the envelope out of the content, then
  // tombstone the body that is left.
  const sealed = extractMediaEnvelopes(content);
  const withdrawn = hideTombstonedMedia({
    content: sealed.body,
    tags,
    hiddenHashes: new Set([media.encryption.sha256]),
  });
  assert.equal(withdrawn.hiddenCount, 1);
  assert.equal(withdrawn.content.includes(URL_A), false);
  assert.equal(withdrawn.tags.length, 0);

  // The envelope goes with the attachment it described: a hidden blob must not
  // leave its real filename, MIME and dimensions readable in the timeline.
  assert.ok(sealed.envelopes.has(URL_A));
  assert.equal(
    survivingMediaEnvelopes(sealed.envelopes, withdrawn.tags).size,
    0,
  );
  // …and an attachment that was *not* withdrawn keeps its envelope.
  assert.equal(survivingMediaEnvelopes(sealed.envelopes, tags).size, 1);
});
