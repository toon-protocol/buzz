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

test("publishEphemeral publishes to the free lane without opening a channel or paying", async () => {
  const EPHEMERAL_EVENT = { ...EVENT, kind: 20001 };
  const client = scriptedClient({
    getRoutePrice: (destination) =>
      Promise.resolve(destination === CONFIG.ephemeralDestination ? 0n : 1000n),
  });
  const writer = writerOver(client);

  await writer.publishEphemeral(EPHEMERAL_EVENT);

  assert.equal(client.published.length, 1);
  assert.equal(client.published[0].event, EPHEMERAL_EVENT);
  assert.equal(
    client.published[0].options.destination,
    CONFIG.ephemeralDestination,
  );
  assert.equal(client.published[0].options.ilpAmount, undefined);
  assert.deepEqual(client.openedChannels, []);
  assert.equal(
    loadPersistedChannel(CONFIG.ephemeralDestination, CONFIG.chain),
    null,
  );
});

test("publishEphemeral pays the ephemeral route's own quoted price when it is non-zero", async () => {
  const client = scriptedClient({
    getRoutePrice: (destination) =>
      Promise.resolve(destination === CONFIG.ephemeralDestination ? 5n : 1000n),
  });
  const writer = writerOver(client);

  await writer.publishEphemeral({ ...EVENT, kind: 20002 });

  assert.equal(client.published[0].options.ilpAmount, 5n);
});

test("publishEphemeral is a silent no-op when the connector does not terminate the free lane (old node)", async () => {
  const client = scriptedClient({ getRoutePrice: () => Promise.resolve(null) });
  const writer = writerOver(client);

  await writer.publishEphemeral({ ...EVENT, kind: 20002 });

  assert.deepEqual(client.published, []);
});

test("publishEphemeral still throws on a genuine refusal from a connector that DOES terminate the lane", async () => {
  const client = scriptedClient({
    getRoutePrice: (destination) =>
      Promise.resolve(destination === CONFIG.ephemeralDestination ? 0n : 1000n),
    publishEvent: () =>
      Promise.resolve({ success: false, error: "rate limited", code: "F09" }),
  });
  const writer = writerOver(client);

  await assert.rejects(
    writer.publishEphemeral({ ...EVENT, kind: 20002 }),
    /rate limited/,
  );
});

test("publishEphemeral asks the connector for the ephemeral route price only once per writer", async () => {
  let priceChecks = 0;
  const client = scriptedClient({
    getRoutePrice: (destination) => {
      if (destination === CONFIG.ephemeralDestination) priceChecks += 1;
      return Promise.resolve(0n);
    },
  });
  const writer = writerOver(client);

  await writer.publishEphemeral({ ...EVENT, kind: 20002 });
  await writer.publishEphemeral({ ...EVENT, kind: 20001 });

  assert.equal(priceChecks, 1);
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

test("payFactoryJobIncrement turns a raw connector negotiation failure into a human sentence, keeping the raw error as cause", async () => {
  const rawError = new Error(
    'No negotiation metadata for peer "abc" — was bootstrap completed? (and the route\'s x402 greeting carried no settlement facts to bootstrap from)',
  );
  const client = scriptedClient({
    openChannel: () => Promise.reject(rawError),
  });
  const writer = writerOver(client);

  await assert.rejects(
    writer.payFactoryJobIncrement({
      destination: "g.toon.provider-xyz",
      amountBaseUnits: 1n,
      conditionHex: "ab".repeat(32),
      jobEventId: "offer-event-id",
    }),
    (error) => {
      assert.doesNotMatch(error.message, /negotiation metadata/i);
      assert.match(error.message, /payment session|not ready|try again/i);
      assert.equal(error.cause, rawError);
      return true;
    },
  );
});

test("payFactoryJobIncrement humanizes any other thrown setup failure without leaking the raw message", async () => {
  const client = scriptedClient({
    signBalanceProof: () => Promise.reject(new Error("boom, internal detail")),
  });
  const writer = writerOver(client);

  await assert.rejects(
    writer.payFactoryJobIncrement({
      destination: "g.toon.provider-xyz",
      amountBaseUnits: 1n,
      conditionHex: "ab".repeat(32),
      jobEventId: "offer-event-id",
    }),
    (error) => {
      assert.doesNotMatch(error.message, /boom/);
      assert.match(error.message, /try again/i);
      return true;
    },
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

test("getSessionLease is undefined until the first successful write", async () => {
  const client = scriptedClient({
    getLastConnectorRouteTerms: () => ({
      extra: { session_lease_ttl_ms: 120_000 },
    }),
  });
  const writer = writerOver(client);

  assert.equal(writer.getSessionLease(), undefined);
});

test("getSessionLease reads session_lease_ttl_ms off the greeting's extra bag after a write lands (toon-client#509)", async () => {
  const before = Date.now();
  const client = scriptedClient({
    getLastConnectorRouteTerms: () => ({
      extra: { session_lease_ttl_ms: 120_000 },
    }),
  });
  const writer = writerOver(client);

  await writer.publish(EVENT);

  const lease = writer.getSessionLease();
  assert.equal(lease.sessionLeaseTtlMs, 120_000);
  assert.ok(lease.observedAtMs >= before);
  assert.ok(lease.observedAtMs <= Date.now());
});

test("getSessionLease also updates from a factory-job increment payment", async () => {
  const client = scriptedClient({
    getLastConnectorRouteTerms: () => ({
      extra: { session_lease_ttl_ms: 45_000 },
    }),
  });
  const writer = writerOver(client);

  await writer.payFactoryJobIncrement({
    destination: "g.toon.provider-xyz",
    amountBaseUnits: 1n,
    conditionHex: "ab".repeat(32),
    jobEventId: "offer-event-id",
  });

  assert.equal(writer.getSessionLease().sessionLeaseTtlMs, 45_000);
});

test("getSessionLease stays undefined against a client build without getLastConnectorRouteTerms", async () => {
  const client = scriptedClient(); // no getLastConnectorRouteTerms — predates issue #509
  const writer = writerOver(client);

  await writer.publish(EVENT);

  assert.equal(writer.getSessionLease(), undefined);
});

test("getSessionLease stays undefined when the greeting carried no session_lease_ttl_ms (connector predates #722)", async () => {
  const client = scriptedClient({
    getLastConnectorRouteTerms: () => ({ extra: { settlement: "evm" } }),
  });
  const writer = writerOver(client);

  await writer.publish(EVENT);

  assert.equal(writer.getSessionLease(), undefined);
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

/**
 * buzz#135 — the factory-job delivery seam. The provider-session delivery
 * port is constructed BEFORE the client (so its `handleJob` can register as
 * `ToonClientConfig.jobHandler`) and handed to the factory exactly when the
 * transport runs a BTP session; on one-shot ILP-over-HTTP there is no port
 * at all, because no server-originated PREPARE could ever reach it.
 */
test("the factory receives the delivery port on the default BTP config", async () => {
  const client = scriptedClient();
  let factoryJobDelivery;
  const writer = new ToonPaidWriter(CONFIG, (_config, jobDelivery) => {
    factoryJobDelivery = jobDelivery;
    return Promise.resolve(client);
  });

  const port = await writer.getJobDeliveryPort();

  assert.equal(writer.supportsJobDelivery(), true);
  assert.equal(typeof factoryJobDelivery.handleJob, "function");
  assert.equal(typeof port.encryptArtifact, "function");
  assert.equal(typeof port.waitForPayment, "function");
  // The port the provider surface drives IS the port whose handleJob was
  // registered — arming an increment on any other instance would stage a key
  // no PREPARE ever releases.
  assert.equal(port, factoryJobDelivery);
});

test("HTTP-only transport gets no port and refuses delivery with a reason", async () => {
  const config = resolveToonTransportConfig({
    BUZZ_TOON_MNEMONIC: "test test test",
    BUZZ_TOON_BTP_URL: "off",
  });
  const client = scriptedClient();
  let factoryArgs;
  const writer = new ToonPaidWriter(config, (...args) => {
    factoryArgs = args;
    return Promise.resolve(client);
  });

  assert.equal(writer.supportsJobDelivery(), false);
  await assert.rejects(
    () => writer.getJobDeliveryPort(),
    /BTP session.*quote but never release/s,
  );

  // Quoting (an ordinary paid write) still works — and passes no port.
  await writer.publish(EVENT);
  assert.equal(factoryArgs[1], undefined);
});

test("the delivery port encrypt→handleJob roundtrip releases exactly the staged key", async () => {
  const client = scriptedClient();
  const writer = new ToonPaidWriter(CONFIG, () => Promise.resolve(client));
  const port = await writer.getJobDeliveryPort();

  const encrypted = await port.encryptArtifact(
    new TextEncoder().encode("increment artifact"),
  );
  const waiting = port.waitForPayment({
    offerEventId: "offer-1",
    conditionHex: encrypted.conditionHex,
    priceUsdc: "1000000",
  });

  const conditionBytes = Uint8Array.from(
    encrypted.conditionHex.match(/.{2}/g).map((byte) => parseInt(byte, 16)),
  );
  const answer = await port.handleJob({
    amount: 1000000n,
    destination: "g.toon.client",
    executionCondition: conditionBytes,
    expiresAt: new Date(Date.now() + 30_000),
    data: new Uint8Array(),
  });

  assert.equal(await waiting, true);
  // The fulfillment is the artifact key: decrypting with it must succeed and
  // is condition-checked by the rig helper the buyer tail uses.
  const { decryptIncrementArtifact } = await import("@toon-protocol/rig");
  const plaintext = decryptIncrementArtifact(
    encrypted.ciphertext,
    answer.fulfillment,
    encrypted.conditionHex,
  );
  assert.equal(new TextDecoder().decode(plaintext), "increment artifact");
});
