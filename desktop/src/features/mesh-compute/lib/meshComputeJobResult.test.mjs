import assert from "node:assert/strict";
import test from "node:test";

import { buildMeshComputeJobResultEvent } from "./meshComputeJobResult.ts";

const requestEvent = {
  id: "job-1",
  pubkey: "buyer-1",
  created_at: 1_700_000_000,
  kind: 5098,
  content: "",
  tags: [["i", "hello", "text"]],
  sig: "sig",
};

test("builds a refused kind:6098 result template", () => {
  const template = buildMeshComputeJobResultEvent({
    rootJobId: "job-1",
    lastEventId: "feedback-1",
    buyerPubkey: "buyer-1",
    requestEvent,
    outcome: "refused",
  });

  assert.equal(template.kind, 6098);
  assert.equal(template.content, "");
  assert.deepEqual(template.tags, [
    ["e", "job-1", "", "root"],
    ["e", "feedback-1", "", "reply"],
    ["p", "buyer-1"],
    ["request", JSON.stringify(requestEvent)],
    ["outcome", "refused"],
  ]);
});

test("throws without a root job id", () => {
  assert.throws(() =>
    buildMeshComputeJobResultEvent({
      rootJobId: "",
      lastEventId: "feedback-1",
      buyerPubkey: "buyer-1",
      requestEvent,
      outcome: "refused",
    }),
  );
});

test("throws without a last event id", () => {
  assert.throws(() =>
    buildMeshComputeJobResultEvent({
      rootJobId: "job-1",
      lastEventId: "",
      buyerPubkey: "buyer-1",
      requestEvent,
      outcome: "refused",
    }),
  );
});

test("throws without a buyer pubkey", () => {
  assert.throws(() =>
    buildMeshComputeJobResultEvent({
      rootJobId: "job-1",
      lastEventId: "feedback-1",
      buyerPubkey: "",
      requestEvent,
      outcome: "refused",
    }),
  );
});
