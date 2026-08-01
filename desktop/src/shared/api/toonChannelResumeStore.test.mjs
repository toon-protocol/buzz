import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  clearPersistedChannel,
  hasPersistedChannel,
  loadPersistedChannel,
  savePersistedChannel,
  setToonChannelStorage,
} from "./toonChannelResumeStore.ts";

const DESTINATION = "g.toon.relay";
const CHAIN = "evm:84532";

const CONTEXT = {
  chainType: "evm",
  chainId: 84532,
  tokenNetworkAddress: "0x1E95493fEF46707E034b4a1945f25a8C76A1823D",
  tokenAddress: "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce",
};

/** A disk that survives a "restart" — module state does not carry a cache. */
function fakeDisk(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

let disk;

beforeEach(() => {
  disk = fakeDisk();
  setToonChannelStorage(disk);
});

test("a fresh store has no resumable channel", () => {
  assert.equal(loadPersistedChannel(DESTINATION, CHAIN), null);
  assert.equal(hasPersistedChannel(DESTINATION, CHAIN), false);
});

test("a saved channel survives a restart", () => {
  savePersistedChannel(DESTINATION, CHAIN, {
    channelId: "channel-1",
    context: CONTEXT,
    nonce: 3,
    cumulativeAmount: "9000",
  });

  // Same disk, no cache — what relaunching the app does.
  setToonChannelStorage(disk);

  assert.deepEqual(loadPersistedChannel(DESTINATION, CHAIN), {
    channelId: "channel-1",
    context: CONTEXT,
    nonce: 3,
    cumulativeAmount: "9000",
  });
  assert.equal(hasPersistedChannel(DESTINATION, CHAIN), true);
});

test("a later save overwrites the earlier watermark for the same key", () => {
  savePersistedChannel(DESTINATION, CHAIN, {
    channelId: "channel-1",
    context: CONTEXT,
    nonce: 1,
    cumulativeAmount: "1000",
  });
  savePersistedChannel(DESTINATION, CHAIN, {
    channelId: "channel-1",
    context: CONTEXT,
    nonce: 2,
    cumulativeAmount: "2000",
  });

  const loaded = loadPersistedChannel(DESTINATION, CHAIN);
  assert.equal(loaded.nonce, 2);
  assert.equal(loaded.cumulativeAmount, "2000");
});

test("records for different destinations or chains do not collide", () => {
  savePersistedChannel(DESTINATION, CHAIN, {
    channelId: "channel-1",
    context: CONTEXT,
    nonce: 1,
    cumulativeAmount: "1000",
  });

  assert.equal(loadPersistedChannel("g.toon.other", CHAIN), null);
  assert.equal(loadPersistedChannel(DESTINATION, "evm:1"), null);
  assert.equal(loadPersistedChannel(DESTINATION, CHAIN).channelId, "channel-1");
});

test("clearing forgets the resumable channel", () => {
  savePersistedChannel(DESTINATION, CHAIN, {
    channelId: "channel-1",
    context: CONTEXT,
    nonce: 1,
    cumulativeAmount: "1000",
  });

  clearPersistedChannel(DESTINATION, CHAIN);

  assert.equal(loadPersistedChannel(DESTINATION, CHAIN), null);
});

test("corrupt JSON is treated as no resumable channel, not an error", () => {
  disk.setItem(`buzz-toon-channel.v1:${DESTINATION}|${CHAIN}`, "{not json");
  setToonChannelStorage(disk);

  assert.equal(loadPersistedChannel(DESTINATION, CHAIN), null);
});

test("a record missing required fields is treated as no resumable channel", () => {
  disk.setItem(
    `buzz-toon-channel.v1:${DESTINATION}|${CHAIN}`,
    JSON.stringify({ channelId: "channel-1" }),
  );
  setToonChannelStorage(disk);

  assert.equal(loadPersistedChannel(DESTINATION, CHAIN), null);
});

test("a record with a malformed context is treated as no resumable channel", () => {
  disk.setItem(
    `buzz-toon-channel.v1:${DESTINATION}|${CHAIN}`,
    JSON.stringify({
      channelId: "channel-1",
      nonce: 1,
      cumulativeAmount: "1000",
      context: { chainType: "evm" }, // missing chainId / tokenNetworkAddress
    }),
  );
  setToonChannelStorage(disk);

  assert.equal(loadPersistedChannel(DESTINATION, CHAIN), null);
});
