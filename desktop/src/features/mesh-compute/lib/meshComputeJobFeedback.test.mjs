import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeshComputeAcceptedEvent,
  buildMeshComputeCompletedOfferEvent,
  buildMeshComputeRefusedEvent,
} from "./meshComputeJobFeedback.ts";

test("builds an accepted kind:7000 template", () => {
  const template = buildMeshComputeAcceptedEvent({
    rootJobId: "job-1",
    buyerPubkey: "buyer-1",
  });
  assert.equal(template.kind, 7000);
  assert.equal(template.content, "");
  assert.deepEqual(template.tags, [
    ["status", "accepted"],
    ["e", "job-1", "", "root"],
    ["p", "buyer-1"],
  ]);
});

test("accepted throws without a root job id", () => {
  assert.throws(() =>
    buildMeshComputeAcceptedEvent({ rootJobId: "", buyerPubkey: "buyer-1" }),
  );
});

test("accepted throws without a buyer pubkey", () => {
  assert.throws(() =>
    buildMeshComputeAcceptedEvent({ rootJobId: "job-1", buyerPubkey: "" }),
  );
});

test("builds a refused kind:7000 template with a reason tag", () => {
  const template = buildMeshComputeRefusedEvent({
    rootJobId: "job-1",
    buyerPubkey: "buyer-1",
    reason: "context-exceeded",
  });
  assert.equal(template.kind, 7000);
  assert.equal(template.content, "");
  assert.deepEqual(template.tags, [
    ["status", "refused"],
    ["e", "job-1", "", "root"],
    ["p", "buyer-1"],
    ["reason", "context-exceeded"],
  ]);
});

test("refused carries an optional free-text elaboration in content", () => {
  const template = buildMeshComputeRefusedEvent({
    rootJobId: "job-1",
    buyerPubkey: "buyer-1",
    reason: "vram-exhausted",
    message: "out of VRAM for this model right now",
  });
  assert.equal(template.content, "out of VRAM for this model right now");
});

test("builds a completed-offer kind:7000 template per §6.2", () => {
  const template = buildMeshComputeCompletedOfferEvent({
    rootJobId: "job-1",
    acceptedEventId: "accepted-1",
    buyerPubkey: "buyer-1",
    amountMicroUsdc: 4_000n,
    conditionHex: "ab".repeat(32),
    ciphertextBase64: "Q0lQSEVSVEVYVA==",
  });
  assert.equal(template.kind, 7000);
  // §6.2: the completion itself, encrypted, inline — content IS the ciphertext.
  assert.equal(template.content, "Q0lQSEVSVEVYVA==");
  assert.deepEqual(template.tags, [
    ["status", "completed-offer"],
    ["e", "job-1", "", "root"],
    ["e", "accepted-1", "", "reply"],
    ["p", "buyer-1"],
    ["amount", "4000", "usdc"],
    ["condition", "ab".repeat(32)],
  ]);
});

test("completed-offer throws without an acceptance to reply to", () => {
  assert.throws(() =>
    buildMeshComputeCompletedOfferEvent({
      rootJobId: "job-1",
      acceptedEventId: "",
      buyerPubkey: "buyer-1",
      amountMicroUsdc: 4_000n,
      conditionHex: "ab".repeat(32),
      ciphertextBase64: "Q0lQSEVSVEVYVA==",
    }),
  );
});

test("completed-offer throws on a non-positive amount", () => {
  assert.throws(() =>
    buildMeshComputeCompletedOfferEvent({
      rootJobId: "job-1",
      acceptedEventId: "accepted-1",
      buyerPubkey: "buyer-1",
      amountMicroUsdc: 0n,
      conditionHex: "ab".repeat(32),
      ciphertextBase64: "Q0lQSEVSVEVYVA==",
    }),
  );
});

test("completed-offer throws without a condition or ciphertext", () => {
  assert.throws(() =>
    buildMeshComputeCompletedOfferEvent({
      rootJobId: "job-1",
      acceptedEventId: "accepted-1",
      buyerPubkey: "buyer-1",
      amountMicroUsdc: 4_000n,
      conditionHex: "",
      ciphertextBase64: "Q0lQSEVSVEVYVA==",
    }),
  );
  assert.throws(() =>
    buildMeshComputeCompletedOfferEvent({
      rootJobId: "job-1",
      acceptedEventId: "accepted-1",
      buyerPubkey: "buyer-1",
      amountMicroUsdc: 4_000n,
      conditionHex: "ab".repeat(32),
      ciphertextBase64: "",
    }),
  );
});

test("refused throws without a root job id", () => {
  assert.throws(() =>
    buildMeshComputeRefusedEvent({
      rootJobId: "",
      buyerPubkey: "buyer-1",
      reason: "model-not-loaded",
    }),
  );
});

test("refused throws without a buyer pubkey", () => {
  assert.throws(() =>
    buildMeshComputeRefusedEvent({
      rootJobId: "job-1",
      buyerPubkey: "",
      reason: "model-not-loaded",
    }),
  );
});
