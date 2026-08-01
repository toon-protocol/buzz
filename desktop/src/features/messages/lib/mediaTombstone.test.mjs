import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMediaTombstoneTags,
  collectHiddenMedia,
  hiddenMediaNotice,
  hideTombstonedMedia,
  isMediaTombstone,
  mediaTombstoneHashes,
  permanentMediaHashes,
} from "./mediaTombstone.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TX_A = "hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";
const TX_B = "Q2Vs2p3TbYQ8h9zJ7c1LmNoPqRsTuVwXyZaBcDeFgHi";
const URL_A = `https://ar-io.dev/${TX_A}`;
const URL_B = `https://ar-io.dev/${TX_B}`;

function imeta(url, hash) {
  return ["imeta", `url ${url}`, "m image/png", `x ${hash}`];
}

test("a kind:5 with an x tag is a media tombstone; one without is not", () => {
  assert.equal(
    isMediaTombstone([
      ["e", "abc"],
      ["x", HASH_A],
    ]),
    true,
  );
  assert.equal(isMediaTombstone([["e", "abc"]]), false);
});

test("only well-formed sha256s count as tombstone targets", () => {
  // A malformed `x` must not turn a whole-message deletion into a media
  // tombstone — that would silently resurrect a message its author deleted.
  assert.deepEqual(mediaTombstoneHashes([["x", "nope"]]), []);
  assert.equal(
    isMediaTombstone([
      ["e", "abc"],
      ["x", "nope"],
    ]),
    false,
  );
});

test("tombstone hashes are lowercased and deduplicated", () => {
  const tags = buildMediaTombstoneTags({
    channelId: "chan",
    eventId: "evt",
    sha256s: [HASH_A.toUpperCase(), HASH_A, HASH_B],
  });
  assert.deepEqual(tags, [
    ["h", "chan"],
    ["e", "evt"],
    ["x", HASH_A],
    ["x", HASH_B],
  ]);
});

test("a tombstone naming no valid attachment is refused at build time", () => {
  // Publishing one would be a paid write that reads, to every other client,
  // as a whole-message deletion.
  assert.throws(
    () =>
      buildMediaTombstoneTags({
        channelId: "chan",
        eventId: "evt",
        sha256s: ["not-a-hash"],
      }),
    /at least one attachment/,
  );
});

test("collectHiddenMedia indexes tombstones by the message they target", () => {
  const hidden = collectHiddenMedia([
    { kind: 9, tags: [imeta(URL_A, HASH_A)] },
    {
      kind: 5,
      tags: [
        ["e", "EVT1"],
        ["x", HASH_A],
      ],
    },
    {
      kind: 5,
      tags: [
        ["e", "evt1"],
        ["x", HASH_B],
      ],
    },
    { kind: 5, tags: [["e", "evt2"]] },
  ]);
  assert.deepEqual([...(hidden.get("evt1") ?? [])], [HASH_A, HASH_B]);
  assert.equal(hidden.has("evt2"), false);
});

test("hiding an attachment removes both its imeta tag and its body line", () => {
  // Either one left behind still renders the media: the gallery enumerates
  // tags, the markdown renderer draws the line.
  const result = hideTombstonedMedia({
    content: `look at this\n![image](${URL_A})\n![image](${URL_B})`,
    tags: [["h", "chan"], imeta(URL_A, HASH_A), imeta(URL_B, HASH_B)],
    hiddenHashes: new Set([HASH_A]),
  });

  assert.equal(result.hiddenCount, 1);
  assert.equal(result.content, `look at this\n![image](${URL_B})`);
  assert.deepEqual(result.tags, [["h", "chan"], imeta(URL_B, HASH_B)]);
});

test("hiding takes an attachment out of the middle of a body", () => {
  const result = hideTombstonedMedia({
    content: `before\n![image](${URL_A})\nafter`,
    tags: [imeta(URL_A, HASH_A)],
    hiddenHashes: new Set([HASH_A]),
  });
  assert.equal(result.content, "before\nafter");
});

test("hiding an attachment also takes its thumbnail and poster", () => {
  const thumb = `https://ar-io.dev/${TX_B}`;
  const result = hideTombstonedMedia({
    content: `![video](${URL_A})\n![image](${thumb})`,
    tags: [
      ["imeta", `url ${URL_A}`, "m video/mp4", `x ${HASH_A}`, `thumb ${thumb}`],
    ],
    hiddenHashes: new Set([HASH_A]),
  });
  assert.equal(result.content, "");
  assert.deepEqual(result.tags, []);
});

test("a message with nothing hidden is returned untouched", () => {
  const tags = [imeta(URL_A, HASH_A)];
  const result = hideTombstonedMedia({
    content: "hi",
    tags,
    hiddenHashes: undefined,
  });
  assert.equal(result.content, "hi");
  assert.equal(result.tags, tags);
  assert.equal(result.hiddenCount, 0);
});

test("a tombstone for an attachment this message does not carry changes nothing", () => {
  const tags = [imeta(URL_A, HASH_A)];
  const result = hideTombstonedMedia({
    content: `![image](${URL_A})`,
    tags,
    hiddenHashes: new Set([HASH_B]),
  });
  assert.equal(result.hiddenCount, 0);
  assert.equal(result.tags, tags);
});

test("the placeholder says hidden, never deleted, and says where the file still is", () => {
  const one = hiddenMediaNotice(1);
  const many = hiddenMediaNotice(3);
  for (const notice of [one, many]) {
    assert.match(notice, /hidden/);
    assert.match(notice, /permaweb/);
    assert.doesNotMatch(notice, /delet/i);
    assert.doesNotMatch(notice, /removed from storage/i);
  }
  assert.match(one, /1 attachment hidden/);
  assert.match(many, /3 attachments hidden/);
});

test("permanentMediaHashes reports permaweb attachments only", () => {
  const tags = [
    imeta(URL_A, HASH_A),
    [
      "imeta",
      "url https://relay.example/media/abc.png",
      "m image/png",
      `x ${HASH_B}`,
    ],
  ];
  assert.deepEqual(permanentMediaHashes(tags), [HASH_A]);
});

test("a permaweb attachment with no hash cannot be named, so it is not offered", () => {
  // A tombstone identifies content by hash; without one there is nothing to
  // put in the `x` tag, and offering a Hide button that cannot work is worse
  // than not offering it.
  assert.deepEqual(
    permanentMediaHashes([["imeta", `url ${URL_A}`, "m image/png"]]),
    [],
  );
});
