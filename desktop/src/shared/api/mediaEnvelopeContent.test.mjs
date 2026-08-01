import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMediaEnvelopes,
  extractMediaEnvelopes,
  hasMediaEnvelopes,
} from "./mediaEnvelopeContent.ts";
import { CHANNEL_MEDIA_SCHEME } from "./channelMediaCrypto.ts";

const URL_A = "https://arweave.net/hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";

function envelope(overrides = {}) {
  return {
    v: 1,
    alg: CHANNEL_MEDIA_SCHEME,
    keyId: "abcdef0123456789",
    salt: "a".repeat(64),
    iv: "b".repeat(24),
    mime: "image/png",
    size: 1234,
    sha256: "c".repeat(64),
    ...overrides,
  };
}

test("a message with no sealed media is untouched", () => {
  const body = "hello\n\n![image](https://arweave.net/x)";
  assert.equal(appendMediaEnvelopes(body, new Map()), body);
  assert.equal(hasMediaEnvelopes(body), false);

  const extracted = extractMediaEnvelopes(body);
  assert.equal(extracted.body, body);
  assert.equal(extracted.envelopes.size, 0);
});

test("an envelope round-trips through the content and leaves the body clean", () => {
  const body = `look at this\n![image](${URL_A})`;
  const content = appendMediaEnvelopes(body, new Map([[URL_A, envelope()]]));

  assert.ok(hasMediaEnvelopes(content));
  // The record is a comment on its own line, so a client that knows nothing
  // about it renders nothing extra.
  assert.match(content, /\n<!--buzz:media\/v1 \{.*\}-->$/);

  const extracted = extractMediaEnvelopes(content);
  assert.equal(extracted.body, body);
  assert.deepEqual(extracted.envelopes.get(URL_A), envelope());
});

test("the record survives a filename that would close the comment early", () => {
  const sealed = envelope({ filename: "q3--final--v2.png" });
  const content = appendMediaEnvelopes("x", new Map([[URL_A, sealed]]));
  // A raw `--` inside an HTML comment ends it in some parsers; the framing
  // must not depend on filenames being polite.
  const json = content.slice("<!--buzz:media/v1 ".length, -"-->".length);
  assert.equal(json.includes("--"), false);
  assert.deepEqual(extractMediaEnvelopes(content).envelopes.get(URL_A), sealed);
});

test("several attachments are keyed by URL, not by position", () => {
  const second = "https://arweave.net/second";
  const map = new Map([
    [URL_A, envelope({ mime: "image/png" })],
    [second, envelope({ mime: "video/mp4", sha256: "d".repeat(64) })],
  ]);
  const extracted = extractMediaEnvelopes(appendMediaEnvelopes("hi", map));
  assert.equal(extracted.envelopes.get(URL_A).mime, "image/png");
  assert.equal(extracted.envelopes.get(second).mime, "video/mp4");
});

test("a corrupt or unrecognised record is dropped, and never rendered", () => {
  // Whatever a future or broken writer produces, the reader must show the
  // message and not the machinery.
  for (const junk of [
    "<!--buzz:media/v1 not json-->",
    '<!--buzz:media/v1 {"https://x":{"v":9}}-->',
    "<!--buzz:media/v1 []-->",
  ]) {
    const extracted = extractMediaEnvelopes(`body text\n${junk}`);
    assert.equal(extracted.body, "body text");
    assert.equal(extracted.envelopes.size, 0);
  }
});

test("an empty body still yields a well-formed record", () => {
  const content = appendMediaEnvelopes("", new Map([[URL_A, envelope()]]));
  assert.ok(content.startsWith("<!--buzz:media/v1 "));
  assert.equal(extractMediaEnvelopes(content).body, "");
});
