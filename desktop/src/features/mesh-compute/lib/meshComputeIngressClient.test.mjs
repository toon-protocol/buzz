import assert from "node:assert/strict";
import test from "node:test";

import {
  callMeshComputeIngress,
  classifyMeshComputeIngressFailure,
} from "./meshComputeIngressClient.ts";

function fakeFetch({ ok, status = 200, jsonBody, textBody, throwError }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throwError) throw throwError;
    return {
      ok,
      status,
      json: async () => jsonBody,
      text: async () => textBody ?? JSON.stringify(jsonBody ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}

const baseInput = {
  baseUrl: "http://127.0.0.1:9337/v1",
  model: "llama-3.1-70b-instruct",
  prompt: "write a haiku about GPUs",
  maxTokens: 512,
  advertisedMaxTokens: 2048,
};

test("returns the completion text on success", async () => {
  const fetchImpl = fakeFetch({
    ok: true,
    jsonBody: { choices: [{ message: { content: "a haiku" } }] },
  });
  const result = await callMeshComputeIngress(baseInput, fetchImpl);
  assert.deepEqual(result, { ok: true, text: "a haiku" });
});

test("posts to /chat/completions with the model, prompt and capped max_tokens", async () => {
  const fetchImpl = fakeFetch({
    ok: true,
    jsonBody: { choices: [{ message: { content: "ok" } }] },
  });
  await callMeshComputeIngress(baseInput, fetchImpl);

  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, "http://127.0.0.1:9337/v1/chat/completions");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "llama-3.1-70b-instruct");
  assert.deepEqual(body.messages, [
    { role: "user", content: "write a haiku about GPUs" },
  ]);
  assert.equal(body.max_tokens, 512);
});

test("clamps max_tokens to the advertised ceiling regardless of what the request asked for", async () => {
  const fetchImpl = fakeFetch({
    ok: true,
    jsonBody: { choices: [{ message: { content: "ok" } }] },
  });
  await callMeshComputeIngress(
    { ...baseInput, maxTokens: 999_999, advertisedMaxTokens: 2048 },
    fetchImpl,
  );
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.max_tokens, 2048);
});

test("a connection failure (ingress not running) is model-not-loaded", async () => {
  const fetchImpl = fakeFetch({ throwError: new Error("ECONNREFUSED") });
  const result = await callMeshComputeIngress(baseInput, fetchImpl);
  assert.deepEqual(result, { ok: false, reason: "model-not-loaded" });
});

test("an unparseable success body is model-not-loaded", async () => {
  const fetchImpl = fakeFetch({ ok: true, jsonBody: { unexpected: true } });
  const result = await callMeshComputeIngress(baseInput, fetchImpl);
  assert.deepEqual(result, { ok: false, reason: "model-not-loaded" });
});

test("an error response is classified via the response body", async () => {
  const fetchImpl = fakeFetch({
    ok: false,
    status: 500,
    textBody: "CUDA error: out of memory",
  });
  const result = await callMeshComputeIngress(baseInput, fetchImpl);
  assert.deepEqual(result, { ok: false, reason: "vram-exhausted" });
});

test("classifyMeshComputeIngressFailure: vram/oom text", () => {
  assert.equal(
    classifyMeshComputeIngressFailure(500, "CUDA out of memory"),
    "vram-exhausted",
  );
  assert.equal(
    classifyMeshComputeIngressFailure(500, "oom while allocating"),
    "vram-exhausted",
  );
});

test("classifyMeshComputeIngressFailure: context-length text", () => {
  assert.equal(
    classifyMeshComputeIngressFailure(
      400,
      "This model's maximum context length is 8192 tokens",
    ),
    "context-exceeded",
  );
});

test("classifyMeshComputeIngressFailure: model-not-found text or 404", () => {
  assert.equal(
    classifyMeshComputeIngressFailure(404, "model not found"),
    "model-not-loaded",
  );
  assert.equal(classifyMeshComputeIngressFailure(404, ""), "model-not-loaded");
});

test("classifyMeshComputeIngressFailure: unrecognized failure falls back to model-not-loaded", () => {
  assert.equal(
    classifyMeshComputeIngressFailure(500, "something unexpected"),
    "model-not-loaded",
  );
});
