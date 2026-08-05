import assert from "node:assert/strict";
import test from "node:test";

import { readAccountIndexWithTimeout } from "./agentProvisioningKeyRead.ts";

test("resolves ok with the account index on a successful read", async () => {
  const outcome = await readAccountIndexWithTimeout({
    read: () => Promise.resolve(3),
    scheduleTimeout: () => () => {},
  });
  assert.deepEqual(outcome, { kind: "ok", accountIndex: 3 });
});

test("resolves ok with null when the index has not been assigned yet", async () => {
  const outcome = await readAccountIndexWithTimeout({
    read: () => Promise.resolve(null),
    scheduleTimeout: () => () => {},
  });
  assert.deepEqual(outcome, { kind: "ok", accountIndex: null });
});

test("resolves error with the rejection message on a failed read", async () => {
  const outcome = await readAccountIndexWithTimeout({
    read: () => Promise.reject(new Error("registry unreachable")),
    scheduleTimeout: () => () => {},
  });
  assert.deepEqual(outcome, { kind: "error", message: "registry unreachable" });
});

test("resolves error with a stringified non-Error rejection", async () => {
  const outcome = await readAccountIndexWithTimeout({
    // eslint-disable-next-line prefer-promise-reject-errors
    read: () => Promise.reject("boom"),
    scheduleTimeout: () => () => {},
  });
  assert.deepEqual(outcome, { kind: "error", message: "boom" });
});

test("resolves timeout when the read never settles before the timeout fires", async () => {
  const outcome = await readAccountIndexWithTimeout({
    read: () => new Promise(() => {}),
    scheduleTimeout: (onTimeout) => {
      onTimeout();
      return () => {};
    },
  });
  assert.deepEqual(outcome, { kind: "timeout" });
});

test("cancels the timeout once the read settles first", async () => {
  let cancelled = false;
  const outcome = await readAccountIndexWithTimeout({
    read: () => Promise.resolve(7),
    scheduleTimeout: () => () => {
      cancelled = true;
    },
  });
  assert.deepEqual(outcome, { kind: "ok", accountIndex: 7 });
  assert.equal(cancelled, true);
});

test("a late timeout after the read already resolved is a no-op", async () => {
  let timeoutFn;
  const outcome = await readAccountIndexWithTimeout({
    read: () => Promise.resolve(1),
    scheduleTimeout: (onTimeout) => {
      timeoutFn = onTimeout;
      return () => {};
    },
  });
  assert.deepEqual(outcome, { kind: "ok", accountIndex: 1 });
  // Simulate a timer that already fired concurrently with the read settling —
  // must not override the resolved outcome or throw on a second resolve.
  assert.doesNotThrow(() => timeoutFn());
});
