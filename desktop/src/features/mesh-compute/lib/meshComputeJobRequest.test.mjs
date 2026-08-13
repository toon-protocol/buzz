import assert from "node:assert/strict";
import test from "node:test";

import { parseMeshComputeJobRequest } from "./meshComputeJobRequest.ts";

function baseEvent(overrides = {}) {
  return {
    id: "req-1",
    pubkey: "buyer-pubkey",
    created_at: 1_700_000_000,
    kind: 5098,
    content: "",
    tags: [
      ["i", "write a haiku about GPUs", "text"],
      ["p", "seller-pubkey"],
      ["model", "llama-3.1-70b-instruct"],
      ["max_tokens", "512"],
      ["price_accept", "2000", "usdc", "1k-output-tokens"],
    ],
    ...overrides,
  };
}

test("parses a well-formed kind:5098 request", () => {
  const parsed = parseMeshComputeJobRequest(baseEvent());
  assert.deepEqual(parsed, {
    eventId: "req-1",
    buyerPubkey: "buyer-pubkey",
    createdAt: 1_700_000_000,
    prompt: "write a haiku about GPUs",
    encrypted: false,
    sellerPubkey: "seller-pubkey",
    model: "llama-3.1-70b-instruct",
    maxTokens: 512,
    priceAccept: {
      microUsdc: 2000n,
      unit: "1k-output-tokens",
    },
  });
});

test("reads the encrypted flag off the encrypted tag", () => {
  const parsed = parseMeshComputeJobRequest(
    baseEvent({
      tags: [
        ["i", "nip44-ciphertext", "text"],
        ["p", "seller-pubkey"],
        ["model", "llama-3.1-70b-instruct"],
        ["max_tokens", "512"],
        ["price_accept", "2000", "usdc", "1k-output-tokens"],
        ["encrypted"],
      ],
    }),
  );
  assert.equal(parsed?.encrypted, true);
});

test("returns null for the wrong kind", () => {
  assert.equal(parseMeshComputeJobRequest(baseEvent({ kind: 5097 })), null);
});

for (const missingTag of ["i", "p", "model", "max_tokens", "price_accept"]) {
  test(`returns null when the ${missingTag} tag is missing`, () => {
    const event = baseEvent();
    event.tags = event.tags.filter((tag) => tag[0] !== missingTag);
    assert.equal(parseMeshComputeJobRequest(event), null);
  });
}

test("returns null for a non-numeric max_tokens", () => {
  const event = baseEvent();
  event.tags = event.tags.map((tag) =>
    tag[0] === "max_tokens" ? ["max_tokens", "not-a-number"] : tag,
  );
  assert.equal(parseMeshComputeJobRequest(event), null);
});

test("returns null for a zero or negative max_tokens", () => {
  const event = baseEvent();
  event.tags = event.tags.map((tag) =>
    tag[0] === "max_tokens" ? ["max_tokens", "0"] : tag,
  );
  assert.equal(parseMeshComputeJobRequest(event), null);
});

test("returns null for a non-numeric price_accept amount", () => {
  const event = baseEvent();
  event.tags = event.tags.map((tag) =>
    tag[0] === "price_accept"
      ? ["price_accept", "not-a-number", "usdc", "1k-output-tokens"]
      : tag,
  );
  assert.equal(parseMeshComputeJobRequest(event), null);
});

test("returns null for a price_accept not denominated in usdc", () => {
  const event = baseEvent();
  event.tags = event.tags.map((tag) =>
    tag[0] === "price_accept"
      ? ["price_accept", "2000", "eth", "1k-output-tokens"]
      : tag,
  );
  assert.equal(parseMeshComputeJobRequest(event), null);
});
