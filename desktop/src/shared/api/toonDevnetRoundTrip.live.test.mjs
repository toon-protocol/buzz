import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import { ToonEventTransport } from "./toonEventTransport.ts";
import { ToonRelayReader } from "./toonRelayReader.ts";
import { resolveToonTransportConfig } from "./toonTransportConfig.ts";

/**
 * The live tracer bullet: a plaintext channel message paid onto the TOON
 * devnet and read back, free, by two independent subscribers.
 *
 * Opt-in. It spends real (test-network) money and needs a funded identity, so
 * it is skipped unless `BUZZ_TOON_LIVE=1` and `BUZZ_TOON_MNEMONIC` are both
 * set — CI without funds runs the rest of the suite unaffected.
 *
 *   BUZZ_TOON_LIVE=1 BUZZ_TOON_MNEMONIC="…" pnpm test
 *
 * The payment identity needs settlement-token balance AND native gas on
 * `BUZZ_TOON_CHAIN` (Base Sepolia by default): opening the payment channel is
 * an on-chain transaction. `https://faucet.devnet.toonprotocol.dev` dispenses
 * both; the Solana leg dispenses gas more reliably than the Base Sepolia one.
 */

const enabled =
  process.env.BUZZ_TOON_LIVE === "1" && Boolean(process.env.BUZZ_TOON_MNEMONIC);

/** The kind and tag shape `sendStreamMessage` puts on a channel message. */
const KIND_STREAM_MESSAGE = 9;
const CHANNEL_ID = "buzz-toon-live-roundtrip";

/** Generous: a channel open is an on-chain transaction on a public testnet. */
const ROUND_TRIP_TIMEOUT_MS = 240_000;

function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(`timed out waiting for ${description}`));
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

test("a paid write round-trips to two free subscribers", {
  skip: enabled ? false : "set BUZZ_TOON_LIVE=1 and BUZZ_TOON_MNEMONIC",
  timeout: ROUND_TRIP_TIMEOUT_MS + 60_000,
}, async () => {
  const config = {
    ...resolveToonTransportConfig(process.env),
    mode: "toon",
  };

  const transport = new ToonEventTransport(config);
  // A second reader on its own socket, standing in for the second connected
  // client: one subscriber seeing its own write proves far less than two.
  const observer = new ToonRelayReader(config.relayUrl);

  const receipts = [];
  transport.onPaidWrite((receipt) => receipts.push(receipt));

  // The event is signed by the *user*, not the payer. Keeping them separate
  // is the point: on TOON the message keeps its author while a different key
  // pays for the packet.
  const authorKey = generateSecretKey();
  const marker = `buzz#11 live round-trip ${new Date().toISOString()}`;
  const event = finalizeEvent(
    {
      kind: KIND_STREAM_MESSAGE,
      content: marker,
      tags: [["h", CHANNEL_ID]],
      created_at: Math.floor(Date.now() / 1000),
    },
    authorKey,
  );

  const filter = {
    kinds: [KIND_STREAM_MESSAGE],
    "#h": [CHANNEL_ID],
    limit: 20,
    since: Math.floor(Date.now() / 1000) - 60,
  };
  const seenByTransport = [];
  const seenByObserver = [];

  // Subscribe BEFORE publishing so the message arrives as a live event
  // rather than as backlog — the tail is what a second client actually sees.
  const disposeA = await transport.subscribeLive(filter, (e) =>
    seenByTransport.push(e),
  );
  const disposeB = await observer.subscribeLive(filter, (e) =>
    seenByObserver.push(e),
  );

  try {
    const quoted = await transport.quoteFee();
    assert.ok(quoted > 0n, "the publish route should quote a non-zero fee");

    const published = await transport.publish(event, {
      timeoutMessage: "Timed out while sending the message.",
      sendErrorMessage: "Failed to send the message.",
    });
    assert.equal(published.id, event.id);

    assert.equal(receipts.length, 1, "the write should report what it cost");
    assert.equal(receipts[0].eventId, event.id);
    assert.equal(receipts[0].amount, quoted);
    assert.equal(receipts[0].destination, config.destination);

    await waitFor(
      () =>
        seenByTransport.some((e) => e.id === event.id) &&
        seenByObserver.some((e) => e.id === event.id),
      ROUND_TRIP_TIMEOUT_MS,
      "both subscribers to see the paid write",
    );

    for (const seen of [seenByTransport, seenByObserver]) {
      const echo = seen.find((e) => e.id === event.id);
      assert.equal(echo.content, marker);
      assert.equal(echo.pubkey, event.pubkey);
      assert.deepEqual(echo.tags, [["h", CHANNEL_ID]]);
    }
  } finally {
    await disposeA();
    await disposeB();
    observer.close();
    await transport.close();
  }
});
