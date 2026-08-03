import assert from "node:assert/strict";
import test from "node:test";

import { parseFactoryJobResult } from "./factoryJobResult.ts";

const ROOT_ID = "job-request-id";

test("a completed job carries the final artifact", () => {
  const parsed = parseFactoryJobResult({
    id: "result-id",
    pubkey: "provider-pubkey",
    created_at: 1_700_000_000,
    kind: 6097,
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["e", "last-offer-id", "", "reply"],
      ["p", "buyer-pubkey"],
      ["outcome", "completed"],
      ["increment", "3", "3"],
      ["i", "final-arweave-tx", "url"],
    ],
  });

  assert.deepEqual(parsed, {
    eventId: "result-id",
    providerPubkey: "provider-pubkey",
    createdAt: 1_700_000_000,
    rootJobId: ROOT_ID,
    outcome: "completed",
    increment: { reached: 3, of: 3 },
    finalArtifactUrl: "final-arweave-tx",
  });
});

test("an abandoned-provider result has no final artifact even if an i tag were present", () => {
  const parsed = parseFactoryJobResult({
    id: "result-id",
    pubkey: "provider-pubkey",
    created_at: 0,
    kind: 6097,
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["outcome", "abandoned-provider"],
      ["increment", "1", "3"],
      ["i", "should-be-ignored", "url"],
    ],
  });

  assert.equal(parsed.outcome, "abandoned-provider");
  assert.equal(parsed.finalArtifactUrl, null);
  assert.deepEqual(parsed.increment, { reached: 1, of: 3 });
});

test("an unrecognized outcome value is rejected", () => {
  assert.equal(
    parseFactoryJobResult({
      id: "result-id",
      pubkey: "p",
      created_at: 0,
      kind: 6097,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["outcome", "cancelled"],
        ["increment", "1", "1"],
      ],
    }),
    null,
  );
});

test("the wrong kind is not parsed", () => {
  assert.equal(
    parseFactoryJobResult({
      id: "e",
      pubkey: "p",
      created_at: 0,
      kind: 7000,
      tags: [],
    }),
    null,
  );
});
