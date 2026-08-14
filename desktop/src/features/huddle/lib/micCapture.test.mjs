import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_MICROPHONE_MESSAGE,
  captureMicWithFallback,
  isNoMicrophoneCaptureError,
} from "./micCapture.ts";

const PREFERRED = {
  echoCancellation: true,
  noiseSuppression: true,
  sampleRate: 48000,
};

test("isNoMicrophoneCaptureError recognizes WebKitGTK's bare Invalid constraint rejection", () => {
  assert.equal(
    isNoMicrophoneCaptureError(new DOMException("Invalid constraint", "Error")),
    true,
  );
});

test("isNoMicrophoneCaptureError recognizes standard no-device DOMException names", () => {
  for (const name of [
    "NotFoundError",
    "DevicesNotFoundError",
    "OverconstrainedError",
    "ConstraintNotSatisfiedError",
  ]) {
    assert.equal(
      isNoMicrophoneCaptureError(new DOMException("no device", name)),
      true,
      name,
    );
  }
});

test("isNoMicrophoneCaptureError does not classify permission errors as no-mic", () => {
  assert.equal(
    isNoMicrophoneCaptureError(new DOMException("denied", "NotAllowedError")),
    false,
  );
});

test("captureMicWithFallback returns the stream from the first successful attempt", async () => {
  const stream = { id: "stream-1" };
  const calls = [];
  const getUserMedia = async (constraints) => {
    calls.push(constraints);
    return stream;
  };
  const result = await captureMicWithFallback(PREFERRED, "", getUserMedia);
  assert.equal(result, stream);
  assert.deepEqual(calls, [{ audio: PREFERRED }]);
});

test("captureMicWithFallback retries without sampleRate, then bare constraints", async () => {
  const stream = { id: "stream-2" };
  const calls = [];
  const getUserMedia = async (constraints) => {
    calls.push(constraints);
    if (calls.length < 3) {
      throw new DOMException("Invalid constraint", "Error");
    }
    return stream;
  };
  const result = await captureMicWithFallback(PREFERRED, "mic-1", getUserMedia);
  assert.equal(result, stream);
  assert.deepEqual(calls, [
    { audio: PREFERRED },
    { audio: { echoCancellation: true, noiseSuppression: true } },
    { audio: { deviceId: { exact: "mic-1" } } },
  ]);
});

test("captureMicWithFallback falls back to true (default input) with no selected device", async () => {
  const calls = [];
  const getUserMedia = async (constraints) => {
    calls.push(constraints);
    if (calls.length < 3) throw new DOMException("Invalid constraint", "Error");
    return { id: "stream-3" };
  };
  await captureMicWithFallback(PREFERRED, "", getUserMedia);
  assert.deepEqual(calls[2], { audio: true });
});

test("captureMicWithFallback resolves to null when every attempt is a no-mic error", async () => {
  const getUserMedia = async () => {
    throw new DOMException("Invalid constraint", "Error");
  };
  const result = await captureMicWithFallback(PREFERRED, "", getUserMedia);
  assert.equal(result, null);
});

test("captureMicWithFallback rethrows a non-device error (e.g. permission denied)", async () => {
  const getUserMedia = async () => {
    throw new DOMException("denied", "NotAllowedError");
  };
  await assert.rejects(
    captureMicWithFallback(PREFERRED, "", getUserMedia),
    (err) => err instanceof DOMException && err.name === "NotAllowedError",
  );
});

test("NO_MICROPHONE_MESSAGE is a non-empty friendly string", () => {
  assert.equal(typeof NO_MICROPHONE_MESSAGE, "string");
  assert.ok(NO_MICROPHONE_MESSAGE.length > 0);
  assert.doesNotMatch(NO_MICROPHONE_MESSAGE.toLowerCase(), /constraint/);
});
