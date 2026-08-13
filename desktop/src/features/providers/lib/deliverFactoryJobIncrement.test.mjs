import assert from "node:assert/strict";
import test from "node:test";

import { parseFactoryJobFeedback } from "@/features/factory-jobs/lib/factoryJobFeedback";
import { parseFactoryJobResult } from "@/features/factory-jobs/lib/factoryJobResult";

import {
  deliverFactoryJobIncrement,
  publishFactoryJobNarration,
  publishFactoryJobResult,
} from "./deliverFactoryJobIncrement.ts";

/**
 * buzz#135 — the provider delivery verbs. Two contracts are asserted here:
 *
 * 1. **Wire compatibility (the issue's own test):** everything published —
 *    the kind:7000 `partial` offer, the free narration, the kind:6097
 *    result — must parse UNCHANGED through the existing buyer-side readers
 *    (`factoryJobFeedback.ts`, `factoryJobResult.ts`).
 * 2. **Delivery order and custody:** only the ciphertext is ever uploaded,
 *    the offer publishes before the payment wait starts, and an HTTP-only
 *    transport is refused before any money is spent.
 */

const JOB = {
  eventId: "job-1",
  buyerPubkey: "b".repeat(64),
  createdAt: 1_700_000_000,
  brief: "Refactor the auth module",
  bidBaseUnits: 5_000_000n,
  repo: "toon-protocol/buzz",
  target: null,
  constraints: null,
  outputMimeType: null,
  targetProviderPubkey: null,
};

const REQUEST_EVENT = {
  id: "job-1",
  pubkey: JOB.buyerPubkey,
  created_at: JOB.createdAt,
  kind: 5097,
  content: "",
  tags: [
    ["i", JOB.brief, "text"],
    ["bid", "5000000", "usdc"],
  ],
  sig: "e".repeat(128),
};

/** Echo the template back as a "signed" event, like the real Tauri command. */
function setupTauriStub() {
  let counter = 0;
  globalThis.window = globalThis.window ?? {};
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command !== "sign_event") {
        throw new Error(`Unexpected Tauri command: ${command}`);
      }
      counter += 1;
      return JSON.stringify({
        id: `signed-${counter}`,
        pubkey: "p".repeat(64),
        created_at: args.createdAt,
        kind: args.kind,
        content: args.content,
        tags: args.tags,
        sig: "s".repeat(128),
      });
    },
  };
}

function teardownTauriStub() {
  delete globalThis.window.__TAURI_INTERNALS__;
}

/** A scripted delivery port + writer + transport, recording every step. */
function scriptedTransport({ paid = true, portError = null } = {}) {
  const log = [];
  const port = {
    async encryptArtifact(bytes) {
      log.push({ step: "encrypt", plaintext: new TextDecoder().decode(bytes) });
      return {
        ciphertext: new TextEncoder().encode("CIPHERTEXT"),
        ciphertextSha256: "ab".repeat(32),
        conditionHex: "cd".repeat(32),
      };
    },
    async waitForPayment(offer) {
      log.push({ step: "wait", offer });
      return paid;
    },
  };
  const writer = {
    async getJobDeliveryPort() {
      if (portError) throw portError;
      return port;
    },
    async uploadBlob(blobData, contentType) {
      log.push({
        step: "upload",
        bytes: new TextDecoder().decode(blobData),
        contentType,
      });
      return { txId: "tx-cipher", receipt: {} };
    },
  };
  const transport = {
    getPaidWriter: () => writer,
    async publish(event) {
      log.push({ step: "publish", event });
      return event;
    },
  };
  return { transport, log };
}

test("delivers an increment: encrypt → upload ciphertext only → spec-compliant offer → payment wait", async () => {
  setupTauriStub();
  const { transport, log } = scriptedTransport({ paid: true });
  try {
    const delivered = await deliverFactoryJobIncrement(
      {
        job: JOB,
        parentEventId: "quote-1",
        increment: {
          n: 1,
          of: 2,
          milestone: "Plan",
          priceUsdcBaseUnits: 1_000_000n,
        },
        artifactBytes: new TextEncoder().encode("the plan"),
      },
      transport,
    );

    assert.deepEqual(
      log.map((entry) => entry.step),
      ["encrypt", "upload", "publish", "wait"],
    );
    // Custody: the plaintext never leaves — only the ciphertext uploads.
    assert.equal(log[1].bytes, "CIPHERTEXT");
    assert.equal(log[1].contentType, "application/octet-stream");

    // The published offer parses UNCHANGED through the buyer-side reader,
    // with every §4.1-required tag (AC1).
    const parsed = parseFactoryJobFeedback(delivered.offerEvent);
    assert.equal(parsed.status, "partial");
    assert.equal(parsed.rootJobId, "job-1");
    assert.equal(parsed.parentEventId, "quote-1");
    assert.equal(parsed.buyerPubkey, JOB.buyerPubkey);
    assert.deepEqual(parsed.increment, { n: 1, of: 2 });
    assert.equal(parsed.artifactUrl, "tx-cipher");
    assert.equal(parsed.artifactHash, "ab".repeat(32));
    assert.equal(parsed.amountBaseUnits, 1_000_000n);
    assert.equal(parsed.conditionHex, "cd".repeat(32));

    // The payment wait was armed for exactly the published offer's condition.
    assert.deepEqual(log[3].offer, {
      offerEventId: delivered.offerEvent.id,
      conditionHex: "cd".repeat(32),
      priceUsdc: "1000000",
    });
    assert.equal(delivered.paid, true);
    assert.equal(delivered.artifactTxId, "tx-cipher");
  } finally {
    teardownTauriStub();
  }
});

test("an unpaid window resolves {paid: false} — a protocol outcome, not an error", async () => {
  setupTauriStub();
  const { transport } = scriptedTransport({ paid: false });
  try {
    const delivered = await deliverFactoryJobIncrement(
      {
        job: JOB,
        parentEventId: "quote-1",
        increment: {
          n: 1,
          of: 1,
          milestone: "implement",
          priceUsdcBaseUnits: 2_000_000n,
        },
        artifactBytes: new Uint8Array([1]),
      },
      transport,
    );
    assert.equal(delivered.paid, false);
  } finally {
    teardownTauriStub();
  }
});

test("onOfferPublished fires with the offer before the payment wait resolves", async () => {
  setupTauriStub();
  const { transport, log } = scriptedTransport({ paid: true });
  try {
    let observedAtCallback = null;
    await deliverFactoryJobIncrement(
      {
        job: JOB,
        parentEventId: "quote-1",
        increment: {
          n: 1,
          of: 1,
          milestone: "plan",
          priceUsdcBaseUnits: 1n,
        },
        artifactBytes: new Uint8Array([1]),
      },
      transport,
      () => {
        observedAtCallback = log.map((entry) => entry.step);
      },
    );
    // The callback saw publish already done but the wait not yet started —
    // this is what lets the UI show "Waiting for buyer payment".
    assert.deepEqual(observedAtCallback, ["encrypt", "upload", "publish"]);
  } finally {
    teardownTauriStub();
  }
});

test("an HTTP-only transport is refused before anything is encrypted or uploaded", async () => {
  setupTauriStub();
  const gate = new Error(
    "Increment delivery needs the connector's BTP session",
  );
  const { transport, log } = scriptedTransport({ portError: gate });
  try {
    await assert.rejects(
      () =>
        deliverFactoryJobIncrement(
          {
            job: JOB,
            parentEventId: "quote-1",
            increment: {
              n: 1,
              of: 1,
              milestone: "plan",
              priceUsdcBaseUnits: 1n,
            },
            artifactBytes: new Uint8Array([1]),
          },
          transport,
        ),
      /BTP session/,
    );
    assert.deepEqual(log, []);
  } finally {
    teardownTauriStub();
  }
});

test("narration parses as §6 processing — no artifact tags to pay against", async () => {
  setupTauriStub();
  const { transport } = scriptedTransport();
  try {
    const event = await publishFactoryJobNarration(
      {
        job: JOB,
        parentEventId: "offer-1",
        message: "Increment 2: 3 of 4 tickets landed, running the gate now.",
      },
      transport,
    );
    const parsed = parseFactoryJobFeedback(event);
    assert.equal(parsed.status, "processing");
    assert.equal(parsed.rootJobId, "job-1");
    assert.equal(parsed.parentEventId, "offer-1");
    assert.equal(
      parsed.narration,
      "Increment 2: 3 of 4 tickets landed, running the gate now.",
    );
  } finally {
    teardownTauriStub();
  }
});

test("a completed result parses through the buyer-side kind:6097 reader with the final artifact", async () => {
  setupTauriStub();
  const { transport } = scriptedTransport();
  try {
    const event = await publishFactoryJobResult(
      {
        job: JOB,
        requestEvent: REQUEST_EVENT,
        giftWrapped: false,
        lastEventId: "offer-2",
        outcome: "completed",
        reachedIncrement: 2,
        totalIncrements: 2,
        finalArtifactTxId: "tx-final",
      },
      transport,
    );
    const parsed = parseFactoryJobResult(event);
    assert.equal(parsed.outcome, "completed");
    assert.equal(parsed.rootJobId, "job-1");
    assert.deepEqual(parsed.increment, { reached: 2, of: 2 });
    assert.equal(parsed.finalArtifactUrl, "tx-final");
  } finally {
    teardownTauriStub();
  }
});

test("a gift-wrapped job's result redacts the brief from the request tag but still parses", async () => {
  setupTauriStub();
  const { transport } = scriptedTransport();
  try {
    const event = await publishFactoryJobResult(
      {
        job: JOB,
        // For a wrapped brief this is the reconstituted rumor — its content
        // and tags are the confidential brief and must never reach the relay.
        requestEvent: REQUEST_EVENT,
        giftWrapped: true,
        lastEventId: "offer-2",
        outcome: "completed",
        reachedIncrement: 2,
        totalIncrements: 2,
        finalArtifactTxId: "tx-final",
      },
      transport,
    );
    const requestTag = event.tags.find((tag) => tag[0] === "request");
    assert.ok(requestTag, "the request tag must still be present (§5.1)");
    const embedded = JSON.parse(requestTag[1]);
    assert.equal(embedded.content, "");
    assert.deepEqual(embedded.tags, []);
    assert.equal(embedded.id, REQUEST_EVENT.id);
    assert.equal(embedded.pubkey, REQUEST_EVENT.pubkey);
    assert.ok(
      !requestTag[1].includes(JOB.brief),
      "the confidential brief must not appear anywhere in the request tag",
    );
    const parsed = parseFactoryJobResult(event);
    assert.equal(parsed.outcome, "completed");
  } finally {
    teardownTauriStub();
  }
});

test("an abandoned-buyer result parses with how far the job got and no artifact", async () => {
  setupTauriStub();
  const { transport } = scriptedTransport();
  try {
    const event = await publishFactoryJobResult(
      {
        job: JOB,
        requestEvent: REQUEST_EVENT,
        giftWrapped: false,
        lastEventId: "offer-2",
        outcome: "abandoned-buyer",
        reachedIncrement: 1,
        totalIncrements: 2,
      },
      transport,
    );
    const parsed = parseFactoryJobResult(event);
    assert.equal(parsed.outcome, "abandoned-buyer");
    assert.deepEqual(parsed.increment, { reached: 1, of: 2 });
    assert.equal(parsed.finalArtifactUrl, null);
  } finally {
    teardownTauriStub();
  }
});
