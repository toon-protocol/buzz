import assert from "node:assert/strict";
import test from "node:test";

import { parseFactoryJobFeedback } from "./factoryJobFeedback.ts";

const ROOT_ID = "job-request-id";
const PROVIDER = "provider-pubkey";

function baseEvent(overrides = {}) {
  return {
    id: "event-id",
    pubkey: PROVIDER,
    created_at: 1_700_000_000,
    kind: 7000,
    content: "",
    tags: [["e", ROOT_ID, "", "root"]],
    ...overrides,
  };
}

test("parses a quote's increment schedule", () => {
  const event = baseEvent({
    content: JSON.stringify({
      increments: [
        { n: 1, of: 3, milestone: "plan", priceUsdc: "500000" },
        { n: 2, of: 3, milestone: "implement", priceUsdc: "4000000" },
        { n: 3, of: 3, milestone: "review", priceUsdc: "500000" },
      ],
    }),
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["p", "buyer-pubkey"],
      ["status", "quote"],
    ],
  });

  const parsed = parseFactoryJobFeedback(event);

  assert.deepEqual(parsed, {
    eventId: "event-id",
    providerPubkey: PROVIDER,
    createdAt: 1_700_000_000,
    rootJobId: ROOT_ID,
    status: "quote",
    increments: [
      { n: 1, of: 3, milestone: "plan", priceUsdcBaseUnits: 500_000n },
      { n: 2, of: 3, milestone: "implement", priceUsdcBaseUnits: 4_000_000n },
      { n: 3, of: 3, milestone: "review", priceUsdcBaseUnits: 500_000n },
    ],
  });
});

test("a quote with unparseable content is malformed", () => {
  const event = baseEvent({
    content: "not json",
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["status", "quote"],
    ],
  });
  assert.deepEqual(parseFactoryJobFeedback(event), {
    status: "malformed",
    eventId: "event-id",
    reason: "unparseable quote content",
  });
});

test("parses a per-increment offer — the relay/connector join", () => {
  const event = baseEvent({
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["e", "quote-event-id", "", "reply"],
      ["p", "buyer-pubkey"],
      ["status", "partial"],
      ["increment", "1", "1"],
      ["i", "arweave-tx-id", "url"],
      ["i", "ciphertext-hash", "text", "", "hash"],
      ["amount", "5000000", "usdc"],
      ["condition", "a".repeat(64)],
    ],
  });

  const parsed = parseFactoryJobFeedback(event);

  assert.deepEqual(parsed, {
    eventId: "event-id",
    providerPubkey: PROVIDER,
    createdAt: 1_700_000_000,
    rootJobId: ROOT_ID,
    status: "partial",
    parentEventId: "quote-event-id",
    buyerPubkey: "buyer-pubkey",
    increment: { n: 1, of: 1 },
    artifactUrl: "arweave-tx-id",
    artifactHash: "ciphertext-hash",
    amountBaseUnits: 5_000_000n,
    conditionHex: "a".repeat(64),
  });
});

test("a partial offer whose amount unit is not usdc is malformed (§4.1)", () => {
  const event = baseEvent({
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["e", "quote-event-id", "", "reply"],
      ["p", "buyer-pubkey"],
      ["status", "partial"],
      ["increment", "1", "1"],
      ["i", "arweave-tx-id", "url"],
      ["amount", "5000000", "millisats"],
      ["condition", "a".repeat(64)],
    ],
  });
  assert.deepEqual(parseFactoryJobFeedback(event), {
    status: "malformed",
    eventId: "event-id",
    reason: "amount must be denominated in usdc",
  });
});

test("a partial offer missing the condition tag is malformed, never treated as free", () => {
  const event = baseEvent({
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["e", "quote-event-id", "", "reply"],
      ["p", "buyer-pubkey"],
      ["status", "partial"],
      ["increment", "1", "1"],
      ["i", "arweave-tx-id", "url"],
      ["amount", "5000000", "usdc"],
    ],
  });
  const parsed = parseFactoryJobFeedback(event);
  assert.equal(parsed.status, "malformed");
});

test("a partial offer missing the reply e-tag is malformed (§4.1 Required)", () => {
  const event = baseEvent({
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["p", "buyer-pubkey"],
      ["status", "partial"],
      ["increment", "1", "1"],
      ["i", "arweave-tx-id", "url"],
      ["amount", "5000000", "usdc"],
      ["condition", "a".repeat(64)],
    ],
  });
  const parsed = parseFactoryJobFeedback(event);
  assert.equal(parsed.status, "malformed");
});

test("a partial offer missing the buyer p tag is malformed (§4.1 Required)", () => {
  const event = baseEvent({
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["e", "quote-event-id", "", "reply"],
      ["status", "partial"],
      ["increment", "1", "1"],
      ["i", "arweave-tx-id", "url"],
      ["amount", "5000000", "usdc"],
      ["condition", "a".repeat(64)],
    ],
  });
  const parsed = parseFactoryJobFeedback(event);
  assert.equal(parsed.status, "malformed");
});

test("parses free narration", () => {
  const event = baseEvent({
    content:
      "Increment 2 (implement): 3 of 4 tickets landed, running the gate now.",
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["e", "prior-event-id", "", "reply"],
      ["p", "buyer-pubkey"],
      ["status", "processing"],
    ],
  });

  const parsed = parseFactoryJobFeedback(event);

  assert.deepEqual(parsed, {
    eventId: "event-id",
    providerPubkey: PROVIDER,
    createdAt: 1_700_000_000,
    rootJobId: ROOT_ID,
    status: "processing",
    parentEventId: "prior-event-id",
    narration:
      "Increment 2 (implement): 3 of 4 tickets landed, running the gate now.",
  });
});

test("narration carrying amount/condition/i is malformed — a client must never pay against it", () => {
  const event = baseEvent({
    content: "sneaky",
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["status", "processing"],
      ["amount", "1", "usdc"],
      ["condition", "a".repeat(64)],
    ],
  });
  const parsed = parseFactoryJobFeedback(event);
  assert.deepEqual(parsed, {
    status: "malformed",
    eventId: "event-id",
    reason: "narration MUST NOT carry i/amount/condition tags",
  });
});

test("missing root e-tag is malformed regardless of status", () => {
  const event = baseEvent({ tags: [["status", "quote"]] });
  assert.deepEqual(parseFactoryJobFeedback(event), {
    status: "malformed",
    eventId: "event-id",
    reason: "missing root e-tag",
  });
});

test("an unrecognized status is malformed", () => {
  const event = baseEvent({
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["status", "something-else"],
    ],
  });
  const parsed = parseFactoryJobFeedback(event);
  assert.equal(parsed.status, "malformed");
});

test("the wrong kind is not parsed at all", () => {
  const event = baseEvent({ kind: 1 });
  assert.equal(parseFactoryJobFeedback(event), null);
});
