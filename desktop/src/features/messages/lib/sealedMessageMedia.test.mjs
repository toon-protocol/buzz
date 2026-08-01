import assert from "node:assert/strict";
import test from "node:test";

import {
  applySealedMessageMedia,
  DECRYPTING_ATTACHMENT_PLACEHOLDER,
  LOCKED_ATTACHMENT_PLACEHOLDER,
  UNAVAILABLE_ATTACHMENT_PLACEHOLDER,
} from "./sealedMessageMedia.ts";
import { CHANNEL_MEDIA_SCHEME } from "@/shared/api/channelMediaCrypto";

const URL_A = "https://arweave.net/hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";
const OBJECT_URL = "blob:app://1234";

const ENVELOPE = {
  v: 1,
  alg: CHANNEL_MEDIA_SCHEME,
  keyId: "abcdef0123456789",
  salt: "a".repeat(64),
  iv: "b".repeat(24),
  mime: "image/png",
  size: 4096,
  sha256: "c".repeat(64),
  dim: "800x600",
  filename: "chart.png",
};

/** The clear-text imeta entry a sealed attachment publishes. */
const CIPHERTEXT_ENTRY = {
  url: URL_A,
  m: "application/octet-stream",
  x: "c".repeat(64),
  size: 4112,
};

test("a public message passes through by reference", () => {
  // Every non-encrypted timeline row goes down this path; a copy here would
  // invalidate memos across the whole timeline.
  const body = "hi";
  const imeta = new Map([[URL_A, CIPHERTEXT_ENTRY]]);
  const result = applySealedMessageMedia(body, imeta, undefined, new Map());
  assert.equal(result.body, body);
  assert.equal(result.imetaByUrl, imeta);
});

test("a decrypted attachment renders as its object URL with plaintext facts", () => {
  const body = `look\n![image](${URL_A})`;
  const result = applySealedMessageMedia(
    body,
    new Map([[URL_A, CIPHERTEXT_ENTRY]]),
    new Map([[URL_A, ENVELOPE]]),
    new Map([[URL_A, { status: "ready", objectUrl: OBJECT_URL }]]),
  );

  assert.equal(result.body, `look\n![image](${OBJECT_URL})`);
  // The Arweave URL is gone from the lookup: nothing should try to load it.
  assert.equal(result.imetaByUrl.has(URL_A), false);

  const entry = result.imetaByUrl.get(OBJECT_URL);
  // The envelope wins on every plaintext fact — that is what makes video
  // detection, the lightbox and the file card work for sealed media.
  assert.equal(entry.m, "image/png");
  assert.equal(entry.size, 4096);
  assert.equal(entry.dim, "800x600");
  assert.equal(entry.filename, "chart.png");
  // …but the public identity stays the ciphertext hash, so a `["x", …]`
  // tombstone still matches the attachment it withdraws.
  assert.equal(entry.x, ENVELOPE.sha256);
});

test("a non-member sees the locked treatment, not a broken image", () => {
  const result = applySealedMessageMedia(
    `hello\n![image](${URL_A})`,
    new Map([[URL_A, CIPHERTEXT_ENTRY]]),
    new Map([[URL_A, ENVELOPE]]),
    new Map([[URL_A, { status: "locked" }]]),
  );

  assert.equal(result.body, `hello\n${LOCKED_ATTACHMENT_PLACEHOLDER}`);
  // Nothing left in the lookup means nothing left to fetch: the ciphertext URL
  // must not reach an `<img>` for a reader who cannot open it.
  assert.equal(result.imetaByUrl, undefined);
  assert.equal(result.body.includes(URL_A), false);
});

test("in-flight and unreachable read differently", () => {
  // "Still working" and "no gateway would serve it" are different situations
  // for the user; only one of them is worth acting on.
  const loading = applySealedMessageMedia(
    `![image](${URL_A})`,
    undefined,
    new Map([[URL_A, ENVELOPE]]),
    new Map([[URL_A, { status: "loading" }]]),
  );
  assert.equal(loading.body, DECRYPTING_ATTACHMENT_PLACEHOLDER);

  const errored = applySealedMessageMedia(
    `![image](${URL_A})`,
    undefined,
    new Map([[URL_A, ENVELOPE]]),
    new Map([[URL_A, { status: "error" }]]),
  );
  assert.equal(errored.body, UNAVAILABLE_ATTACHMENT_PLACEHOLDER);
});

test("an unresolved attachment defaults to in-flight rather than to shown", () => {
  const result = applySealedMessageMedia(
    `![image](${URL_A})`,
    undefined,
    new Map([[URL_A, ENVELOPE]]),
    new Map(),
  );
  assert.equal(result.body.includes(URL_A), false);
});

test("spoilered and file-card lines are handled by the same rule", () => {
  const spoilered = applySealedMessageMedia(
    `||![image](${URL_A})||`,
    undefined,
    new Map([[URL_A, ENVELOPE]]),
    new Map([[URL_A, { status: "ready", objectUrl: OBJECT_URL }]]),
  );
  assert.equal(spoilered.body, `||![image](${OBJECT_URL})||`);

  const fileCard = applySealedMessageMedia(
    `[report.pdf](${URL_A})`,
    undefined,
    new Map([[URL_A, ENVELOPE]]),
    new Map([[URL_A, { status: "locked" }]]),
  );
  assert.equal(fileCard.body, LOCKED_ATTACHMENT_PLACEHOLDER);
});

test("one locked attachment does not hide the others", () => {
  const second = "https://arweave.net/second";
  const result = applySealedMessageMedia(
    `![image](${URL_A})\n![image](${second})`,
    undefined,
    new Map([
      [URL_A, ENVELOPE],
      [second, { ...ENVELOPE, sha256: "d".repeat(64) }],
    ]),
    new Map([
      [URL_A, { status: "locked" }],
      [second, { status: "ready", objectUrl: OBJECT_URL }],
    ]),
  );
  assert.equal(
    result.body,
    `${LOCKED_ATTACHMENT_PLACEHOLDER}\n![image](${OBJECT_URL})`,
  );
});
