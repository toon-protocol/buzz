import assert from "node:assert/strict";
import test from "node:test";

import { runMeshComputeJob } from "./runMeshComputeJob.ts";

const request = {
  eventId: "req-1",
  buyerPubkey: "buyer-1",
  createdAt: 1_700_000_000,
  prompt: "write a haiku about GPUs",
  encrypted: false,
  sellerPubkey: "seller-1",
  model: "llama-3.1-70b-instruct",
  maxTokens: 512,
  priceAccept: { microUsdc: 2000n, unit: "1k-output-tokens" },
};

test("returns the completion on a successful ingress call", async () => {
  const calls = [];
  const callIngress = async (input) => {
    calls.push(input);
    return { ok: true, text: "a haiku" };
  };

  const outcome = await runMeshComputeJob(
    {
      request,
      maxTokens: 512,
      advertisedMaxTokens: 2048,
      ingressBaseUrl: "http://127.0.0.1:9337/v1",
    },
    callIngress,
  );

  assert.deepEqual(outcome, { kind: "completed", text: "a haiku" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    baseUrl: "http://127.0.0.1:9337/v1",
    model: "llama-3.1-70b-instruct",
    prompt: "write a haiku about GPUs",
    maxTokens: 512,
    advertisedMaxTokens: 2048,
  });
});

test("forwards the ingress's refusal reason on failure", async () => {
  const callIngress = async () => ({ ok: false, reason: "vram-exhausted" });

  const outcome = await runMeshComputeJob(
    {
      request,
      maxTokens: 512,
      advertisedMaxTokens: 2048,
      ingressBaseUrl: "http://127.0.0.1:9337/v1",
    },
    callIngress,
  );

  assert.deepEqual(outcome, { kind: "refused", reason: "vram-exhausted" });
});
