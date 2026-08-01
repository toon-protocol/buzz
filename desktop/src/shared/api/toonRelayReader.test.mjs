import assert from "node:assert/strict";
import test from "node:test";

import { ToonRelayReader } from "./toonRelayReader.ts";

const EVENT = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1785400000,
  kind: 9,
  tags: [["h", "channel-1"]],
  content: "hello",
  sig: "c".repeat(128),
};

/** A scriptable stand-in for the browser `WebSocket`. */
function fakeSocket() {
  const listeners = new Map();
  const socket = {
    sent: [],
    closed: false,
    send(data) {
      socket.sent.push(JSON.parse(data));
    },
    close() {
      socket.closed = true;
    },
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    emit(type, payload) {
      for (const listener of listeners.get(type) ?? []) listener(payload);
    },
  };
  return socket;
}

/** A reader wired to a fake socket that is already open. */
function openReader() {
  const sockets = [];
  const reader = new ToonRelayReader("wss://relay.test", () => {
    const socket = fakeSocket();
    sockets.push(socket);
    // Open on the next tick, the way a real socket would.
    queueMicrotask(() => socket.emit("open"));
    return socket;
  });
  const current = () => sockets[sockets.length - 1];
  /** Wait until the reader has actually written a frame to the socket. */
  const nextSent = async () => {
    for (let i = 0; i < 50 && (current()?.sent.length ?? 0) === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return current().sent[0];
  };
  return { reader, sockets, current, nextSent };
}

test("subscribing sends a REQ with the caller's filter", async () => {
  const { reader, current } = openReader();

  await reader.subscribeLive({ kinds: [9], "#h": ["c1"], limit: 10 }, () => {});

  const [req] = current().sent;
  assert.equal(req[0], "REQ");
  assert.match(req[1], /^toon-live-/);
  assert.deepEqual(req[2], { kinds: [9], "#h": ["c1"], limit: 10 });
  reader.close();
});

test("EOSE resolves the subscription rather than the readiness timer", async () => {
  const { reader, current, nextSent } = openReader();
  const pending = reader.subscribeLive({ kinds: [9], limit: 1 }, () => {});

  const subId = (await nextSent())[1];
  current().emit("message", { data: JSON.stringify(["EOSE", subId]) });

  await pending;
  reader.close();
});

test("events reach only the subscription that asked for them", async () => {
  const { reader, current } = openReader();
  const mine = [];
  const theirs = [];

  await reader.subscribeLive({ kinds: [9], limit: 1 }, (e) => mine.push(e));
  await reader.subscribeLive({ kinds: [7], limit: 1 }, (e) => theirs.push(e));

  const [firstReq, secondReq] = current().sent;
  current().emit("message", {
    data: JSON.stringify(["EVENT", firstReq[1], EVENT]),
  });

  assert.deepEqual(mine, [EVENT]);
  assert.deepEqual(theirs, []);
  assert.notEqual(firstReq[1], secondReq[1]);
  reader.close();
});

test("a doubly-encoded event still reaches the subscriber", async () => {
  const { reader, current } = openReader();
  const received = [];

  await reader.subscribeLive({ kinds: [9], limit: 1 }, (e) => received.push(e));
  const subId = current().sent[0][1];
  current().emit("message", {
    data: JSON.stringify(["EVENT", subId, JSON.stringify(EVENT)]),
  });

  assert.deepEqual(received, [EVENT]);
  reader.close();
});

test("disposing sends CLOSE and stops delivery", async () => {
  const { reader, current } = openReader();
  const received = [];

  const dispose = await reader.subscribeLive({ kinds: [9], limit: 1 }, (e) =>
    received.push(e),
  );
  const subId = current().sent[0][1];
  await dispose();

  current().emit("message", {
    data: JSON.stringify(["EVENT", subId, EVENT]),
  });

  assert.deepEqual(received, []);
  assert.deepEqual(current().sent.at(-1), ["CLOSE", subId]);
  reader.close();
});

test("fetchEvents collects until EOSE and then closes", async () => {
  const { reader, current, nextSent } = openReader();
  const pending = reader.fetchEvents({ kinds: [9], limit: 2 });

  const subId = (await nextSent())[1];
  const second = { ...EVENT, id: "d".repeat(64) };
  current().emit("message", { data: JSON.stringify(["EVENT", subId, EVENT]) });
  current().emit("message", { data: JSON.stringify(["EVENT", subId, second]) });
  current().emit("message", { data: JSON.stringify(["EOSE", subId]) });

  assert.deepEqual(await pending, [EVENT, second]);
  assert.deepEqual(current().sent.at(-1), ["CLOSE", subId]);
  reader.close();
});

test("fetchEvents tolerates a double-encoded EVENT frame, same as a live subscription", async () => {
  const { reader, current, nextSent } = openReader();
  const pending = reader.fetchEvents({ kinds: [9], limit: 1 });

  const subId = (await nextSent())[1];
  // The devnet relay sometimes double-encodes an EVENT payload: the event
  // arrives as a JSON string containing the event JSON, rather than inline.
  // A history REQ (this method) is exactly how `getChannelWindowPage` pages
  // TOON history, so it needs the same tolerance `subscribeLive` already has.
  current().emit("message", {
    data: JSON.stringify(["EVENT", subId, JSON.stringify(EVENT)]),
  });
  current().emit("message", { data: JSON.stringify(["EOSE", subId]) });

  assert.deepEqual(await pending, [EVENT]);
  reader.close();
});

test("a CLOSED subscription is dropped, not replayed", async () => {
  const { reader, current } = openReader();

  await reader.subscribeLive({ kinds: [9], limit: 1 }, () => {});
  const socket = current();
  const subId = socket.sent[0][1];
  socket.emit("message", {
    data: JSON.stringify(["CLOSED", subId, "rate-limited"]),
  });

  // Nothing left to replay, so a drop does not schedule a reconnect.
  socket.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reader.isConnected(), false);
  reader.close();
});

test("malformed frames are ignored rather than thrown", async () => {
  const { reader, current } = openReader();
  const received = [];

  await reader.subscribeLive({ kinds: [9], limit: 1 }, (e) => received.push(e));
  current().emit("message", { data: "<html>502</html>" });
  current().emit("message", { data: JSON.stringify(["EVENT"]) });
  current().emit("message", { data: 42 });

  assert.deepEqual(received, []);
  reader.close();
});
