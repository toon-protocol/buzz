import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  loadPersistedChannel,
  savePersistedChannel,
  setToonChannelStorage,
} from "./toonChannelResumeStore.ts";
import { ToonPaidWriter, transportEndpointFields } from "./toonPaidWriter.ts";
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
    sendSwapPacket(swapParams) {
      this.swapPackets = this.swapPackets ?? [];
      this.swapPackets.push(swapParams);
      return Promise.resolve({
        accepted: true,
        // base64("f".repeat(32) as bytes)... a fixed 32-byte fulfillment, base64-encoded.
        fulfillment: Buffer.from("f".repeat(32), "utf8").toString("base64"),
      });
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

test("payFactoryJobIncrement opens a channel to the PROVIDER, not the writer's relay destination", async () => {
  const client = scriptedClient();
  const writer = writerOver(client);
  const conditionHex = "ab".repeat(32);

  const receipt = await writer.payFactoryJobIncrement({
    destination: "g.toon.provider-xyz",
    amountBaseUnits: 5_000_000n,
    conditionHex,
    jobEventId: "offer-event-id",
  });

  assert.equal(client.openedChannels.length, 1);
  assert.equal(client.openedChannels[0].destination, "g.toon.provider-xyz");
  assert.equal(client.swapPackets.length, 1);
  assert.equal(client.swapPackets[0].destination, "g.toon.provider-xyz");
  assert.equal(client.swapPackets[0].amount, 5_000_000n);
  assert.deepEqual(
    [...client.swapPackets[0].executionCondition],
    [...Buffer.from(conditionHex, "hex")],
  );
  assert.equal(
    new TextDecoder().decode(client.swapPackets[0].toonData),
    "offer-event-id",
  );

  const expectedFulfillmentHex = Buffer.from("f".repeat(32), "utf8").toString(
    "hex",
  );
  assert.equal(receipt.fulfillmentHex, expectedFulfillmentHex);
  assert.equal(receipt.destination, "g.toon.provider-xyz");
  assert.equal(receipt.amount, 5_000_000n);

  // The writer's OWN relay channel is untouched by a job payment.
  assert.equal(loadPersistedChannel(CONFIG.destination, CONFIG.chain), null);
});

test("payFactoryJobIncrement rejects a malformed condition before touching the network", async () => {
  const client = scriptedClient();
  const writer = writerOver(client);

  await assert.rejects(
    writer.payFactoryJobIncrement({
      destination: "g.toon.provider-xyz",
      amountBaseUnits: 1n,
      conditionHex: "not-hex",
      jobEventId: "offer-event-id",
    }),
    /32 bytes hex/,
  );
  assert.equal(client.openedChannels.length, 0);
});

test("payFactoryJobIncrement throws when the connector refuses the payment", async () => {
  const client = scriptedClient({
    sendSwapPacket: () =>
      Promise.resolve({
        accepted: false,
        code: "F04",
        message: "insufficient funds",
      }),
  });
  const writer = writerOver(client);

  await assert.rejects(
    writer.payFactoryJobIncrement({
      destination: "g.toon.provider-xyz",
      amountBaseUnits: 1n,
      conditionHex: "ab".repeat(32),
      jobEventId: "offer-event-id",
    }),
    /insufficient funds/,
  );
});

test("payFactoryJobIncrement throws when accepted but no fulfillment came back — money must never move without the key", async () => {
  const client = scriptedClient({
    sendSwapPacket: () => Promise.resolve({ accepted: true }),
  });
  const writer = writerOver(client);

  await assert.rejects(
    writer.payFactoryJobIncrement({
      destination: "g.toon.provider-xyz",
      amountBaseUnits: 1n,
      conditionHex: "ab".repeat(32),
      jobEventId: "offer-event-id",
    }),
    /no fulfillment/,
  );
});

test("getNetworkFlowStatus returns null when no channel has ever opened", async () => {
  const client = scriptedClient();
  const writer = writerOver(client);

  assert.equal(await writer.getNetworkFlowStatus(), null);
});

test("getNetworkFlowStatus prefers a verified claim-state read over the local watermark", async () => {
  const client = scriptedClient({
    getChannelDepositTotal: () => 999n,
    getChannelCumulativeAmount: () => 999n,
    getClaimState: (channelIds) =>
      Promise.resolve(
        channelIds.map(() => ({
          ok: true,
          depositTotal: "10000000",
          cumulativeClaimed: "4000000",
        })),
      ),
  });
  const writer = writerOver(client);
  await writer.publish(EVENT);

  const status = await writer.getNetworkFlowStatus();
  assert.equal(status.source, "claim-state");
  assert.equal(status.depositTotalBaseUnits, 10_000_000n);
  assert.equal(status.cumulativeClaimedBaseUnits, 4_000_000n);
  assert.equal(status.creditedBaseUnits, 0n);
});

test("getNetworkFlowStatus splits a negative claim-state watermark into a credited amount (buzz#108)", async () => {
  // A watermark below zero is the connector's netted signal that this
  // identity has been credited more than it has spent on this channel
  // (@toon-protocol/client's "Earning" docs, toon-meta#262 decision 9).
  const client = scriptedClient({
    getClaimState: (channelIds) =>
      Promise.resolve(
        channelIds.map(() => ({
          ok: true,
          depositTotal: "10000000",
          cumulativeClaimed: "-1500000",
        })),
      ),
  });
  const writer = writerOver(client);
  await writer.publish(EVENT);

  const status = await writer.getNetworkFlowStatus();
  assert.equal(status.source, "claim-state");
  assert.equal(status.depositTotalBaseUnits, 10_000_000n);
  assert.equal(status.cumulativeClaimedBaseUnits, 0n);
  assert.equal(status.creditedBaseUnits, 1_500_000n);
});

test("getNetworkFlowStatus falls back to the local watermark when the client has no getClaimState", async () => {
  const client = scriptedClient({
    getChannelDepositTotal: () => 5_000_000n,
    getChannelCumulativeAmount: () => 1_000_000n,
  });
  const writer = writerOver(client);
  await writer.publish(EVENT);

  const status = await writer.getNetworkFlowStatus();
  assert.equal(status.source, "local");
  assert.equal(status.depositTotalBaseUnits, 5_000_000n);
  assert.equal(status.cumulativeClaimedBaseUnits, 1_000_000n);
  assert.equal(status.creditedBaseUnits, 0n);
});

test("getNetworkFlowStatus falls back to the local watermark when claim-state is unreachable", async () => {
  const client = scriptedClient({
    getChannelDepositTotal: () => 5_000_000n,
    getChannelCumulativeAmount: () => 1_000_000n,
    getClaimState: () => Promise.reject(new Error("connector unreachable")),
  });
  const writer = writerOver(client);
  await writer.publish(EVENT);

  const status = await writer.getNetworkFlowStatus();
  assert.equal(status.source, "local");
});

test("getNetworkFlowStatus falls back to the local watermark when the connector could not verify the challenge", async () => {
  const client = scriptedClient({
    getChannelDepositTotal: () => 5_000_000n,
    getChannelCumulativeAmount: () => 1_000_000n,
    getClaimState: () => Promise.resolve([{ ok: false }]),
  });
  const writer = writerOver(client);
  await writer.publish(EVENT);

  const status = await writer.getNetworkFlowStatus();
  assert.equal(status.source, "local");
});

test("the client is built for the BTP session by default (buzz#23 stage 2)", () => {
  // `proxyUrl` must NOT be among the fields: the real client prefers the
  // stateless HTTP transport whenever a proxyUrl is present, which caps paid
  // writes at ~16 fps — not viable for 50 fps huddle audio.
  const fields = transportEndpointFields(CONFIG);

  assert.deepEqual(fields, {
    connectorUrl: CONFIG.connectorUrl,
    btpUrl: CONFIG.btpUrl,
    btpAuthToken: "",
  });
});

test("opting out of BTP falls back to one-shot ILP-over-HTTP", () => {
  const config = resolveToonTransportConfig({
    BUZZ_TOON_MNEMONIC: "test test test",
    BUZZ_TOON_BTP_URL: "off",
  });

  assert.deepEqual(transportEndpointFields(config), {
    proxyUrl: config.proxyUrl,
  });
});
