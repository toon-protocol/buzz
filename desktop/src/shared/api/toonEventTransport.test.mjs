import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { setToonChannelStorage } from "./toonChannelResumeStore.ts";
import { ToonEventTransport } from "./toonEventTransport.ts";
import { ToonPaidWriter } from "./toonPaidWriter.ts";
import { resolveToonTransportConfig } from "./toonTransportConfig.ts";

// Each test's `scriptedClient()` starts a fresh in-memory channel map, so an
// isolated disk keeps the resume-or-open decision (buzz#28) from depending on
// what an earlier test in this file happened to persist.
beforeEach(() => {
  const values = new Map();
  setToonChannelStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
});

const EVENT = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1785400000,
  kind: 9,
  tags: [["h", "channel-1"]],
  content: "hello",
  sig: "c".repeat(128),
};

const MESSAGES = {
  timeoutMessage: "Timed out while sending the message.",
  sendErrorMessage: "Failed to send the message.",
};

const CONFIG = resolveToonTransportConfig({
  BUZZ_TOON_MNEMONIC: "test test test",
});

/** A `ToonPaidWriter` over a scripted client — no network, no chain. */
function writerOver(client) {
  return new ToonPaidWriter(CONFIG, () => Promise.resolve(client));
}

function scriptedClient(overrides = {}) {
  // Real (in-memory) channel/nonce bookkeeping, matching `ToonClient` closely
  // enough for `ToonPaidWriter`'s resume-or-open + claim-signing path
  // (buzz#28) — the resume behavior itself is covered in
  // `toonPaidWriter.test.mjs`; these fixtures just need it to work.
  const channels = new Map();
  let openCount = 0;
  return {
    started: 0,
    published: [],
    channelManager: {
      isTracking: (channelId) => channels.has(channelId),
      trackChannel(channelId, _context, initialNonce = 0, initialAmount = 0n) {
        channels.set(channelId, {
          nonce: initialNonce,
          cumulativeAmount: initialAmount,
        });
      },
    },
    start() {
      this.started += 1;
      return Promise.resolve({});
    },
    stop: () => Promise.resolve(),
    getRoutePrice: () => Promise.resolve(1000n),
    openChannel() {
      openCount += 1;
      const channelId = `channel-${openCount}`;
      channels.set(channelId, { nonce: 0, cumulativeAmount: 0n });
      return Promise.resolve(channelId);
    },
    signBalanceProof(channelId, amount) {
      const tracking = channels.get(channelId);
      if (!tracking) {
        return Promise.reject(new Error(`channel "${channelId}" not tracked`));
      }
      tracking.nonce += 1;
      tracking.cumulativeAmount += amount;
      return Promise.resolve({
        channelId,
        nonce: tracking.nonce,
        transferredAmount: tracking.cumulativeAmount,
      });
    },
    publishEvent(event, options) {
      this.published.push({ event, options });
      return Promise.resolve({ success: true, eventId: event.id });
    },
    ...overrides,
  };
}

/** A reader stub — reads are a separate network from writes. */
function stubReader(overrides = {}) {
  return {
    ready: () => Promise.resolve(),
    close: () => {},
    subscribeLive: () => Promise.resolve(async () => {}),
    fetchEvents: () => Promise.resolve([]),
    ...overrides,
  };
}

test("a successful paid write resolves with the event it was given", async () => {
  const client = scriptedClient();
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(client),
    reader: stubReader(),
  });

  const published = await transport.publish(EVENT, MESSAGES);

  assert.deepEqual(published, EVENT);
  assert.equal(client.published.length, 1);
  assert.equal(client.published[0].options.destination, "g.toon.relay");
});

test("the write pays the price the connector quoted", async () => {
  // The fee must be the route's own price, not a locally invented number: an
  // underpaid packet is rejected, an overpaid one silently costs the user.
  const client = scriptedClient({
    getRoutePrice: () => Promise.resolve(2500n),
  });
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(client),
    reader: stubReader(),
  });

  await transport.publish(EVENT, MESSAGES);

  assert.equal(client.published[0].options.ilpAmount, 2500n);
});

test("each write reports what it cost", async () => {
  const writer = writerOver(scriptedClient());
  const transport = new ToonEventTransport(CONFIG, {
    writer,
    reader: stubReader(),
  });
  const receipts = [];
  transport.onPaidWrite((receipt) => receipts.push(receipt));

  await transport.publish(EVENT, MESSAGES);

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].eventId, EVENT.id);
  assert.equal(receipts[0].amount, 1000n);
  assert.equal(receipts[0].asset, "USDC");
  assert.equal(receipts[0].destination, "g.toon.relay");
});

test("a refused packet surfaces the caller's copy and the reason", async () => {
  const client = scriptedClient({
    publishEvent: () =>
      Promise.resolve({
        success: false,
        error: "insufficient collateral",
        code: "F06",
        refusedBy: "destination",
      }),
  });
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(client),
    reader: stubReader(),
  });

  await assert.rejects(transport.publish(EVENT, MESSAGES), (error) => {
    assert.match(error.message, /Failed to send the message\./);
    assert.match(error.message, /insufficient collateral/);
    assert.match(error.message, /F06/);
    assert.match(error.message, /refused by destination/);
    return true;
  });
});

function freeLaneClient(overrides = {}) {
  return scriptedClient({
    getRoutePrice: (destination) =>
      Promise.resolve(destination === CONFIG.ephemeralDestination ? 0n : 1000n),
    ...overrides,
  });
}

test("ephemeral writes are published to the free lane, not dropped", async () => {
  let openChannelCalls = 0;
  const client = freeLaneClient({
    openChannel: (...args) => {
      openChannelCalls += 1;
      return scriptedClient().openChannel(...args);
    },
  });
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(client),
    reader: stubReader(),
  });

  await transport.publishEphemeral({ ...EVENT, kind: 20002 });

  assert.equal(client.published.length, 1);
  assert.equal(
    client.published[0].options.destination,
    CONFIG.ephemeralDestination,
  );
  assert.equal(openChannelCalls, 0);
});

test("ephemeral writes degrade to a silent no-op when the connector has no free lane (old node)", async () => {
  const client = scriptedClient({ getRoutePrice: () => Promise.resolve(null) });
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(client),
    reader: stubReader(),
  });

  await transport.publishEphemeral({ ...EVENT, kind: 20002 });

  assert.deepEqual(client.published, []);
});

test("ephemeral writes never reject, even when the connector refuses them", async (t) => {
  // publishEphemeral is fire-and-forget by contract (EventTransport's doc):
  // a droppable event's loss must never surface as a rejected promise.
  const client = freeLaneClient({
    publishEvent: () =>
      Promise.resolve({ success: false, error: "rate limited" }),
  });
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(client),
    reader: stubReader(),
  });
  t.mock.method(console, "warn", () => {});

  await assert.doesNotReject(
    transport.publishEphemeral({ ...EVENT, kind: 20002 }),
  );
});

test("presence heartbeats reach the free ephemeral lane, not the paid path", async () => {
  const client = freeLaneClient();
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(client),
    reader: stubReader(),
  });

  const published = await transport.publish(
    { ...EVENT, kind: 20001 },
    MESSAGES,
  );

  assert.equal(client.published.length, 1);
  assert.equal(
    client.published[0].options.destination,
    CONFIG.ephemeralDestination,
  );
  // Still resolves with the event, same as a real (paid) publish would, so
  // callers that await the presence write see success either way.
  assert.deepEqual(published, { ...EVENT, kind: 20001 });
});

test("a transport that has not started cannot write", async () => {
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(scriptedClient()),
    reader: stubReader(),
  });

  assert.equal(transport.isWritable(), false);
  await transport.ready();
  assert.equal(transport.isWritable(), true);
});

test("ready() still brings reads up when the payment side fails", async () => {
  // An unfunded client must still be able to read the channel it cannot write
  // to — reads are free and independent of the payment channel.
  let readerReady = false;
  const writer = new ToonPaidWriter(CONFIG, () =>
    Promise.reject(new Error("no collateral")),
  );
  const transport = new ToonEventTransport(CONFIG, {
    writer,
    reader: stubReader({
      ready: () => {
        readerReady = true;
        return Promise.resolve();
      },
    }),
  });

  await assert.rejects(transport.ready(), /no collateral/);
  assert.equal(readerReady, true);
});

test("a failed start is retried rather than cached", async () => {
  let attempts = 0;
  const client = scriptedClient();
  const writer = new ToonPaidWriter(CONFIG, () => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error("edge unreachable"))
      : Promise.resolve(client);
  });
  const transport = new ToonEventTransport(CONFIG, {
    writer,
    reader: stubReader(),
  });

  await assert.rejects(transport.ready(), /edge unreachable/);
  await transport.ready();

  assert.equal(attempts, 2);
  assert.equal(transport.isWritable(), true);
});

test("live subscriptions are served by the reader, not the payer", async () => {
  let subscribed = null;
  const transport = new ToonEventTransport(CONFIG, {
    writer: writerOver(scriptedClient()),
    reader: stubReader({
      subscribeLive: (filter) => {
        subscribed = filter;
        return Promise.resolve(async () => {});
      },
    }),
  });

  await transport.subscribeLive(
    { kinds: [9], "#h": ["c1"], limit: 5 },
    () => {},
  );

  assert.deepEqual(subscribed, { kinds: [9], "#h": ["c1"], limit: 5 });
});
