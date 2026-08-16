import assert from "node:assert/strict";
import test from "node:test";

import { matchMeshComputeCapability } from "./meshComputeJobValidation.ts";

function request(overrides = {}) {
  return {
    eventId: "req-1",
    buyerPubkey: "buyer-pubkey",
    createdAt: 1_700_000_000,
    prompt: "hello",
    encrypted: false,
    sellerPubkey: "seller-pubkey",
    model: "llama-3.1-70b-instruct",
    maxTokens: 512,
    priceAccept: { microUsdc: 2000n, unit: "1k-output-tokens" },
    ...overrides,
  };
}

const capabilities = { modelId: "llama-3.1-70b-instruct", maxVramGb: 48 };
const pricing = { priceMicroUsdcPer1kTokens: 2000n, maxOutputTokens: 2048 };

test("accepts a request that fits the advertised model and ceiling", () => {
  const result = matchMeshComputeCapability(request(), capabilities, pricing);
  assert.deepEqual(result, { accepted: true, maxTokens: 512 });
});

test("accepts a request whose max_tokens exactly equals the ceiling", () => {
  const result = matchMeshComputeCapability(
    request({ maxTokens: 2048 }),
    capabilities,
    pricing,
  );
  assert.deepEqual(result, { accepted: true, maxTokens: 2048 });
});

test("refuses model-not-loaded when no model is advertised", () => {
  const result = matchMeshComputeCapability(
    request(),
    { modelId: null, maxVramGb: null },
    pricing,
  );
  assert.deepEqual(result, { accepted: false, reason: "model-not-loaded" });
});

test("refuses model-not-loaded when the requested model does not match", () => {
  const result = matchMeshComputeCapability(
    request({ model: "mistral-7b" }),
    capabilities,
    pricing,
  );
  assert.deepEqual(result, { accepted: false, reason: "model-not-loaded" });
});

test("refuses context-exceeded when max_tokens exceeds the advertised ceiling", () => {
  const result = matchMeshComputeCapability(
    request({ maxTokens: 4096 }),
    capabilities,
    pricing,
  );
  assert.deepEqual(result, { accepted: false, reason: "context-exceeded" });
});

test("checks the model before the token ceiling", () => {
  const result = matchMeshComputeCapability(
    request({ model: "mistral-7b", maxTokens: 999_999 }),
    capabilities,
    pricing,
  );
  assert.deepEqual(result, { accepted: false, reason: "model-not-loaded" });
});
