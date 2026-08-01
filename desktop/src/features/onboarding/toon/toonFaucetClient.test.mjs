import assert from "node:assert/strict";
import test from "node:test";

import { requestFaucetDrip } from "./toonFaucetClient.ts";

const FAUCET_URL = "https://faucet.example";
const ADDRESS = "0x000000000000000000000000000000000000aa";

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

test("posts to the base-sepolia leg with the address body", async () => {
  let seenUrl;
  let seenBody;
  const fetchImpl = fakeFetch(async (url, init) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(seenUrl, "https://faucet.example/api/base-sepolia/request");
  assert.deepEqual(seenBody, { address: ADDRESS });
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.response, { ok: true });
});

test("tolerates a trailing slash on the faucet URL", async () => {
  let seenUrl;
  const fetchImpl = fakeFetch(async (url) => {
    seenUrl = url;
    return new Response("{}", { status: 200 });
  });

  await requestFaucetDrip({
    faucetUrl: "https://faucet.example/",
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(seenUrl, "https://faucet.example/api/base-sepolia/request");
});

test("a 429 is reported as cooldown, not error, with Retry-After parsed", async () => {
  const fetchImpl = fakeFetch(
    async () =>
      new Response("too many requests", {
        status: 429,
        headers: { "Retry-After": "3600" },
      }),
  );

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(outcome.status, "cooldown");
  assert.equal(outcome.retryAfterSeconds, 3600);
  assert.match(outcome.message, /3600s/);
});

test("a 429 with no Retry-After header still reports cooldown", async () => {
  const fetchImpl = fakeFetch(async () => new Response("", { status: 429 }));

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(outcome.status, "cooldown");
  assert.equal(outcome.retryAfterSeconds, null);
  assert.match(outcome.message, /try again shortly/);
});

test("a non-numeric Retry-After degrades to null rather than NaN", async () => {
  const fetchImpl = fakeFetch(
    async () =>
      new Response("", { status: 429, headers: { "Retry-After": "soon" } }),
  );

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(outcome.retryAfterSeconds, null);
});

test("a non-2xx, non-429 response is a plain error with the status in the message", async () => {
  const fetchImpl = fakeFetch(
    async () =>
      new Response("boom", { status: 500, statusText: "Internal Error" }),
  );

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /500/);
  assert.match(outcome.message, /boom/);
});

test("a network failure is an error outcome, not a throw", async () => {
  const fetchImpl = fakeFetch(async () => {
    throw new Error("ECONNREFUSED");
  });

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /ECONNREFUSED/);
});

test("a request that never resolves times out as an error, not a hang", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
    timeoutMs: 5,
  });

  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /timed out/);
});

test("a non-JSON 2xx body is still success, with the raw text carried through", async () => {
  const fetchImpl = fakeFetch(async () => new Response("ok", { status: 200 }));

  const outcome = await requestFaucetDrip({
    faucetUrl: FAUCET_URL,
    address: ADDRESS,
    fetchImpl,
  });

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.response, "ok");
});
