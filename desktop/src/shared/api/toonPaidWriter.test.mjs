import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  loadPersistedChannel,
  savePersistedChannel,
  setToonChannelStorage,
} from "./toonChannelResumeStore.ts";
import { ToonPaidWriter } from "./toonPaidWriter.ts";
import { resolveToonTransportConfig } from "./toonTransportConfig.ts";

/**
 * Covers buzz#28: `ToonPaidWriter` must resume a persisted payment channel
 * across restarts (no fresh on-chain open, no new collateral) rather than
 * always opening a new one — and must persist the nonce/cumulative-amount
 * watermark before the F01-sensitive claim goes out, not after.
 */

const EVENT = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1785400000,
  kind: 9,
  tags: [["h", "channel-1"]],
  content: "hello",
  sig: "c".repeat(128),
};

const CONFIG = resolveToonTransportConfig({
  BUZZ_TOON_MNEMONIC: "test test test",
});

const EXPECTED_CONTEXT = {
  chainType: "evm",
  chainId: 84532,
  tokenNetworkAddress: CONFIG.tokenNetwork,
  tokenAddress: CONFIG.preferredToken,
};

let disk;

beforeEach(() => {
  disk = new Map();
  setToonChannelStorage({
    getItem: (key) => disk.get(key) ?? null,
    setItem: (key, value) => disk.set(key, value),
    removeItem: (key) => disk.delete(key),
  });
});

/**
 * A `ToonClient`-shaped stub with real (in-memory) nonce/channel bookkeeping,
 * so the resume-vs-open decision and the nonce watermark can be observed the
 * same way they would against the real client.
 */
function scriptedClient(overrides = {}) {
  const channels = new Map(); // channelId -> { nonce, cumulativeAmount }
  let openCount = 0;

  const client = {
    started: 0,
    published: [],
    openedChannels: [],
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
    openChannel(destination) {
      openCount += 1;
      const channelId = `channel-${openCount}`;
      channels.set(channelId, { nonce: 0, cumulativeAmount: 0n });
      this.openedChannels.push({ destination, channelId });
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
  return client;
}

function writerOver(client) {
  return new ToonPaidWriter(CONFIG, () => Promise.resolve(client));
}

test("a fresh writer with no persisted state opens a channel and persists it", async () => {
  const client = scriptedClient();
  const writer = writerOver(client);

  await writer.publish(EVENT);

  assert.equal(client.openedChannels.length, 1);
  assert.equal(client.openedChannels[0].destination, CONFIG.destination);

  const persisted = loadPersistedChannel(CONFIG.destination, CONFIG.chain);
  assert.equal(persisted.channelId, "channel-1");
  assert.equal(persisted.nonce, 1);
  assert.equal(persisted.cumulativeAmount, "1000");
  assert.deepEqual(persisted.context, EXPECTED_CONTEXT);
});

test("a second write on the same writer reuses the channel it already opened", async () => {
  const client = scriptedClient();
  const writer = writerOver(client);

  await writer.publish(EVENT);
  await writer.publish({ ...EVENT, id: "d".repeat(64) });

  // Only ONE on-chain open for the whole writer lifetime, not one per write.
  assert.equal(client.openedChannels.length, 1);
  assert.equal(loadPersistedChannel(CONFIG.destination, CONFIG.chain).nonce, 2);
});

test("a persisted channel is resumed instead of opening a fresh one", async () => {
  savePersistedChannel(CONFIG.destination, CONFIG.chain, {
    channelId: "channel-resumed",
    context: EXPECTED_CONTEXT,
    nonce: 5,
    cumulativeAmount: "5000",
  });
  const client = scriptedClient();
  const writer = writerOver(client);

  await writer.publish(EVENT);

  // No on-chain open — this is the whole point of buzz#28 (no fresh 0.1 USDC
  // collateral lock on restart).
  assert.equal(client.openedChannels.length, 0);
  assert.equal(client.published[0].options.claim.channelId, "channel-resumed");
  // The watermark continues from where it left off, not from zero.
  assert.equal(client.published[0].options.claim.nonce, 6);
  assert.equal(client.published[0].options.claim.transferredAmount, 6000n);

  const persisted = loadPersistedChannel(CONFIG.destination, CONFIG.chain);
  assert.equal(persisted.nonce, 6);
  assert.equal(persisted.cumulativeAmount, "6000");
});

test("a corrupt persisted record falls back to a fresh open rather than failing", async () => {
  disk.set(
    `buzz-toon-channel.v1:${CONFIG.destination}|${CONFIG.chain}`,
    "{not json",
  );
  const client = scriptedClient();
  const writer = writerOver(client);

  await writer.publish(EVENT);

  assert.equal(client.openedChannels.length, 1);
  assert.equal(client.published[0].options.claim.channelId, "channel-1");
});

test("a persisted record for a different destination/chain does not resume", async () => {
  savePersistedChannel("g.toon.other", CONFIG.chain, {
    channelId: "channel-other",
    context: EXPECTED_CONTEXT,
    nonce: 9,
    cumulativeAmount: "9000",
  });
  const client = scriptedClient();
  const writer = writerOver(client);

  await writer.publish(EVENT);

  assert.equal(client.openedChannels.length, 1);
  assert.equal(client.published[0].options.claim.channelId, "channel-1");
});

test("when ToonClient internals cannot be reached, resume falls back to a fresh open", async () => {
  savePersistedChannel(CONFIG.destination, CONFIG.chain, {
    channelId: "channel-resumed",
    context: EXPECTED_CONTEXT,
    nonce: 5,
    cumulativeAmount: "5000",
  });
  const client = scriptedClient({ channelManager: undefined });
  const writer = writerOver(client);

  await writer.publish(EVENT);

  assert.equal(client.openedChannels.length, 1);
  assert.equal(client.published[0].options.claim.channelId, "channel-1");
});

test("the nonce watermark is persisted before the claim reaches the network", async () => {
  // F01-safety: if the write crashes right after this, the persisted nonce
  // must already be at (or ahead of) whatever might have been sent — never
  // behind it, or a resume would replay an already-accepted nonce.
  let nonceOnDiskDuringSend;
  const client = scriptedClient({
    publishEvent(event, options) {
      nonceOnDiskDuringSend = loadPersistedChannel(
        CONFIG.destination,
        CONFIG.chain,
      )?.nonce;
      this.published.push({ event, options });
      return Promise.resolve({ success: true, eventId: event.id });
    },
  });
  const writer = writerOver(client);

  await writer.publish(EVENT);

  assert.equal(nonceOnDiskDuringSend, 1);
});

test("a refused write still leaves the watermark persisted (the claim was issued)", async () => {
  const client = scriptedClient({
    publishEvent: () =>
      Promise.resolve({
        success: false,
        error: "insufficient collateral",
        code: "F06",
      }),
  });
  const writer = writerOver(client);

  await assert.rejects(writer.publish(EVENT));

  const persisted = loadPersistedChannel(CONFIG.destination, CONFIG.chain);
  assert.equal(persisted.nonce, 1);
});
