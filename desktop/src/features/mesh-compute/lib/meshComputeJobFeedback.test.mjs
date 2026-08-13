import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeshComputeAcceptedEvent,
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
