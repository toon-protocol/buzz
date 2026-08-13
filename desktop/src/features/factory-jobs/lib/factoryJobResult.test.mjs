import assert from "node:assert/strict";
import test from "node:test";

import { parseFactoryJobResult } from "./factoryJobResult.ts";

const ROOT_ID = "job-request-id";

const REQUEST_JSON = JSON.stringify({ id: ROOT_ID, kind: 5097 });

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
      ["request", REQUEST_JSON],
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
      ["e", "last-offer-id", "", "reply"],
      ["p", "buyer-pubkey"],
      ["request", REQUEST_JSON],
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
  assert.deepEqual(
    parseFactoryJobResult({
      id: "result-id",
      pubkey: "p",
      created_at: 0,
      kind: 6097,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["e", "last-offer-id", "", "reply"],
        ["p", "buyer-pubkey"],
        ["request", REQUEST_JSON],
        ["outcome", "cancelled"],
        ["increment", "1", "1"],
      ],
    }),
    {
      status: "malformed",
      eventId: "result-id",
      reason: "unrecognized outcome tag: cancelled",
    },
  );
});

test("a result missing the request tag is rejected (§5.1 Required)", () => {
  assert.deepEqual(
    parseFactoryJobResult({
      id: "result-id",
      pubkey: "provider-pubkey",
      created_at: 0,
      kind: 6097,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["e", "last-offer-id", "", "reply"],
        ["p", "buyer-pubkey"],
        ["outcome", "completed"],
        ["increment", "1", "1"],
        ["i", "final-arweave-tx", "url"],
      ],
    }),
    {
      status: "malformed",
      eventId: "result-id",
      reason: "missing request tag",
    },
  );
});

test("a result missing the reply e-tag is rejected (§5.1 Required)", () => {
  assert.deepEqual(
    parseFactoryJobResult({
      id: "result-id",
      pubkey: "provider-pubkey",
      created_at: 0,
      kind: 6097,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["p", "buyer-pubkey"],
        ["request", REQUEST_JSON],
        ["outcome", "completed"],
        ["increment", "1", "1"],
        ["i", "final-arweave-tx", "url"],
      ],
    }),
    {
      status: "malformed",
      eventId: "result-id",
      reason: "missing reply e-tag",
    },
  );
});

test("a result missing the buyer p tag is rejected (§5.1 Required)", () => {
  assert.deepEqual(
    parseFactoryJobResult({
      id: "result-id",
      pubkey: "provider-pubkey",
      created_at: 0,
      kind: 6097,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["e", "last-offer-id", "", "reply"],
        ["request", REQUEST_JSON],
        ["outcome", "completed"],
        ["increment", "1", "1"],
        ["i", "final-arweave-tx", "url"],
      ],
    }),
    {
      status: "malformed",
      eventId: "result-id",
      reason: "missing buyer p tag",
    },
  );
});

test("a completed outcome whose reached increment does not equal the total is rejected", () => {
  assert.deepEqual(
    parseFactoryJobResult({
      id: "result-id",
      pubkey: "provider-pubkey",
      created_at: 0,
      kind: 6097,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["e", "last-offer-id", "", "reply"],
        ["p", "buyer-pubkey"],
        ["request", REQUEST_JSON],
        ["outcome", "completed"],
        ["increment", "2", "3"],
        ["i", "final-arweave-tx", "url"],
      ],
    }),
    {
      status: "malformed",
      eventId: "result-id",
      reason: "completed outcome with reached increment !== of",
    },
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
