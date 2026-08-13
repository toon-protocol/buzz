import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ClientJobDeliveryPort } from "@toon-protocol/rig";

import {
  artifactUrlCandidates,
  decryptFactoryJobArtifact,
  describeFactoryJobArtifact,
  fetchFactoryJobCiphertext,
} from "./factoryJobArtifact.ts";

/**
 * buzz#135 — the buyer decrypt tail, proven against the REAL provider-side
 * crypto: the ciphertext comes out of `ClientJobDeliveryPort.encryptArtifact`
 * (the exact code the provider surface runs) and the key out of its
 * `handleJob` — the fulfillment a paying PREPARE would have carried. No
 * side-channel key ever exists in these tests, which is AC3 verbatim.
 */

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Run the real provider port once: encrypt, arm, release the key. */
async function provideArtifact(plaintext) {
  const port = new ClientJobDeliveryPort();
  const encrypted = await port.encryptArtifact(
    new TextEncoder().encode(plaintext),
  );
  const waiting = port.waitForPayment({
    offerEventId: "offer-1",
    conditionHex: encrypted.conditionHex,
    priceUsdc: "1000000",
  });
  const answer = await port.handleJob({
    amount: 1000000n,
    destination: "g.toon.client",
    executionCondition: hexToBytes(encrypted.conditionHex),
    expiresAt: new Date(Date.now() + 30_000),
    data: new Uint8Array(),
  });
  assert.equal(await waiting, true);
  return { encrypted, fulfillmentHex: bytesToHex(answer.fulfillment) };
}

function fetchServing(bodyByUrl) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const body = bodyByUrl.get(url);
    if (!body) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
  };
  return { fetchImpl, requested };
}

test("a bare tx id resolves to every gateway candidate, best first", () => {
  const candidates = artifactUrlCandidates("A".repeat(43));
  assert.ok(candidates.length >= 1);
  for (const url of candidates) {
    assert.match(url, /^https:\/\/.+A{43}/);
  }
});

test("fetches, hash-checks, and decrypts using only the stored fulfillment", async () => {
  const { encrypted, fulfillmentHex } = await provideArtifact(
    "the delivered increment",
  );
  const [primary] = artifactUrlCandidates("B".repeat(43));
  const { fetchImpl } = fetchServing(
    new Map([[primary, encrypted.ciphertext]]),
  );

  const ciphertext = await fetchFactoryJobCiphertext("B".repeat(43), {
    expectedSha256Hex: encrypted.ciphertextSha256,
    fetchImpl,
  });
  const plaintext = decryptFactoryJobArtifact(
    ciphertext,
    fulfillmentHex,
    encrypted.conditionHex,
  );

  assert.deepEqual(describeFactoryJobArtifact(plaintext), {
    kind: "text",
    text: "the delivered increment",
  });
});

test("a gateway serving wrong bytes is skipped for the next mirror", async () => {
  const { encrypted } = await provideArtifact("real");
  const [primary, mirror] = artifactUrlCandidates("C".repeat(43));
  assert.ok(mirror, "the shared gateway list advertises at least two mirrors");
  const { fetchImpl, requested } = fetchServing(
    new Map([
      [primary, new TextEncoder().encode("corrupted")],
      [mirror, encrypted.ciphertext],
    ]),
  );

  const bytes = await fetchFactoryJobCiphertext("C".repeat(43), {
    expectedSha256Hex: encrypted.ciphertextSha256,
    fetchImpl,
  });

  assert.deepEqual(requested, [primary, mirror]);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    encrypted.ciphertextSha256,
  );
});

test("every gateway failing surfaces one artifact error, not a raw fetch error", async () => {
  const { fetchImpl } = fetchServing(new Map());
  await assert.rejects(
    () => fetchFactoryJobCiphertext("D".repeat(43), { fetchImpl }),
    /Couldn't fetch the encrypted artifact/,
  );
});

test("a wrong key is caught by the condition check instead of decrypting garbage", async () => {
  const { encrypted } = await provideArtifact("locked");
  const wrongKey = "11".repeat(32);
  assert.throws(
    () =>
      decryptFactoryJobArtifact(
        encrypted.ciphertext,
        wrongKey,
        encrypted.conditionHex,
      ),
    /does not decrypt this artifact/,
  );
});

test("a non-UTF-8 artifact reports its size rather than mojibake", () => {
  assert.deepEqual(
    describeFactoryJobArtifact(new Uint8Array([0xff, 0xfe, 0x00, 0xd8])),
    { kind: "binary", byteLength: 4 },
  );
});
