import assert from "node:assert/strict";
import test from "node:test";

import { decodeToonRelayFrame } from "./toonRelayFrames.ts";

const EVENT = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1785400000,
  kind: 9,
  tags: [["h", "channel-1"]],
  content: "hello",
  sig: "c".repeat(128),
};

test("decodes a standard NIP-01 EVENT frame", () => {
  const frame = decodeToonRelayFrame(JSON.stringify(["EVENT", "sub", EVENT]));

  assert.equal(frame?.type, "EVENT");
  assert.equal(frame.subscriptionId, "sub");
  assert.deepEqual(frame.event, EVENT);
});

test("decodes an EVENT whose payload is a JSON string", () => {
  // The devnet relay has been observed serving the event this way: the frame
  // is a normal array, but slot 2 holds the event JSON as a string.
  const raw = JSON.stringify(["EVENT", "sub", JSON.stringify(EVENT)]);

  const frame = decodeToonRelayFrame(raw);

  assert.equal(frame?.type, "EVENT");
  assert.deepEqual(frame.event, EVENT);
});

test("decodes an EVENT whose whole frame is a JSON string", () => {
  const raw = JSON.stringify(JSON.stringify(["EVENT", "sub", EVENT]));

  const frame = decodeToonRelayFrame(raw);

  assert.equal(frame?.type, "EVENT");
  assert.deepEqual(frame.event, EVENT);
});

test("decodes a doubly-encoded frame carrying a doubly-encoded event", () => {
  const raw = JSON.stringify(
    JSON.stringify(["EVENT", "sub", JSON.stringify(EVENT)]),
  );

  const frame = decodeToonRelayFrame(raw);

  assert.equal(frame?.type, "EVENT");
  assert.deepEqual(frame.event, EVENT);
});

test("rejects an EVENT payload that is not event-shaped", () => {
  // The failure this guards is silent corruption, not a throw: without the
  // shape check a bare string sails through as a `RelayEvent` and every
  // downstream read of `.kind`/`.tags` is undefined.
  const raw = JSON.stringify(["EVENT", "sub", "not-an-event"]);

  assert.equal(decodeToonRelayFrame(raw), null);
});

test("rejects an event missing required NIP-01 fields", () => {
  const { sig: _sig, ...noSig } = EVENT;
  const missingKind = { ...EVENT, kind: "9" };

  assert.equal(
    decodeToonRelayFrame(JSON.stringify(["EVENT", "sub", missingKind])),
    null,
  );
  // `sig` is not required by this decoder — the relay only forwards signed
  // events, and the app's own optimistic rows carry an empty one.
  assert.equal(
    decodeToonRelayFrame(JSON.stringify(["EVENT", "sub", noSig]))?.type,
    "EVENT",
  );
});

test("decodes EOSE, CLOSED, OK and NOTICE", () => {
  assert.deepEqual(decodeToonRelayFrame(JSON.stringify(["EOSE", "sub"])), {
    type: "EOSE",
    subscriptionId: "sub",
  });
  assert.deepEqual(
    decodeToonRelayFrame(JSON.stringify(["CLOSED", "sub", "rate-limited"])),
    { type: "CLOSED", subscriptionId: "sub", message: "rate-limited" },
  );
  assert.deepEqual(
    decodeToonRelayFrame(JSON.stringify(["OK", "abc", true, ""])),
    { type: "OK", eventId: "abc", accepted: true, message: "" },
  );
  assert.deepEqual(decodeToonRelayFrame(JSON.stringify(["NOTICE", "hi"])), {
    type: "NOTICE",
    message: "hi",
  });
});

test("returns null for junk rather than throwing", () => {
  assert.equal(decodeToonRelayFrame("not json"), null);
  assert.equal(decodeToonRelayFrame("[]"), null);
  assert.equal(decodeToonRelayFrame("{}"), null);
  assert.equal(decodeToonRelayFrame('"just a string"'), null);
  assert.equal(decodeToonRelayFrame(JSON.stringify(["EVENT"])), null);
});
