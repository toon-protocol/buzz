import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFactoryJobRequest,
  parseFactoryJobRequest,
} from "./factoryJobRequest.ts";

test("builds the i/bid tags every request needs", () => {
  const template = buildFactoryJobRequest({
    brief: "Deflake the thread-focus-mode spec",
    bidBaseUnits: 5_000_000n,
  });

  assert.equal(template.kind, 5097);
  assert.equal(template.content, "");
  assert.deepEqual(template.tags, [
    ["i", "Deflake the thread-focus-mode spec", "text"],
    ["bid", "5000000", "usdc"],
  ]);
});

test("optional params/output/p tags are appended only when supplied", () => {
  const template = buildFactoryJobRequest({
    brief: "Implement buzz#56",
    bidBaseUnits: 5_000_000n,
    repo: "toon-protocol/buzz",
    target: "buzz#56",
    constraints: "must keep the file under 1000 lines",
    outputMimeType: "application/json",
    targetProviderPubkey: "ab".repeat(32),
  });

  assert.deepEqual(template.tags, [
    ["i", "Implement buzz#56", "text"],
    ["bid", "5000000", "usdc"],
    ["param", "repo", "toon-protocol/buzz"],
    ["param", "target", "buzz#56"],
    ["param", "constraints", "must keep the file under 1000 lines"],
    ["output", "application/json"],
    ["p", "ab".repeat(32)],
  ]);
});

test("rejects an empty brief", () => {
  assert.throws(() =>
    buildFactoryJobRequest({ brief: "   ", bidBaseUnits: 1n }),
  );
});

test("rejects a non-positive bid", () => {
  assert.throws(() => buildFactoryJobRequest({ brief: "x", bidBaseUnits: 0n }));
  assert.throws(() =>
    buildFactoryJobRequest({ brief: "x", bidBaseUnits: -1n }),
  );
});

test("round-trips through parseFactoryJobRequest", () => {
  const template = buildFactoryJobRequest({
    brief: "Implement buzz#56",
    bidBaseUnits: 5_000_000n,
    repo: "toon-protocol/buzz",
  });

  const parsed = parseFactoryJobRequest({
    id: "event-id",
    pubkey: "buyer-pubkey",
    created_at: 1_700_000_000,
    kind: template.kind,
    tags: template.tags,
  });

  assert.deepEqual(parsed, {
    eventId: "event-id",
    buyerPubkey: "buyer-pubkey",
    createdAt: 1_700_000_000,
    brief: "Implement buzz#56",
    bidBaseUnits: 5_000_000n,
    repo: "toon-protocol/buzz",
    target: null,
    constraints: null,
    outputMimeType: null,
    targetProviderPubkey: null,
  });
});

test("parse returns null for the wrong kind or missing required tags", () => {
  assert.equal(
    parseFactoryJobRequest({
      id: "e",
      pubkey: "p",
      created_at: 0,
      kind: 1,
      tags: [
        ["i", "brief", "text"],
        ["bid", "1", "usdc"],
      ],
    }),
    null,
  );
  assert.equal(
    parseFactoryJobRequest({
      id: "e",
      pubkey: "p",
      created_at: 0,
      kind: 5097,
      tags: [["bid", "1", "usdc"]],
    }),
    null,
  );
  assert.equal(
    parseFactoryJobRequest({
      id: "e",
      pubkey: "p",
      created_at: 0,
      kind: 5097,
      tags: [
        ["i", "brief", "text"],
        ["bid", "not-a-number", "usdc"],
      ],
    }),
    null,
  );
});
