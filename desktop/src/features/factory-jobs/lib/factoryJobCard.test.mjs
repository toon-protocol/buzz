import assert from "node:assert/strict";
import test from "node:test";

import { deriveFactoryJobCard } from "./factoryJobCard.ts";

const ROOT_ID = "a".repeat(64);
const PROVIDER_PUBKEY = "b".repeat(64);
const BUYER_PUBKEY = "c".repeat(64);
// The quote this branch's partial offer (§4.1) or result (§5.1) replies to
// via the `reply` e-tag. buzz#126 (kind:7000) and buzz#150 (kind:6097) made
// both parsers reject spec-Required omissions, so a fixture missing this —
// or the buyer `p` tag, or 6097's `request` tag — now parses as malformed
// and renders "unrecognized" rather than its card.
const QUOTE_ID = "f".repeat(64);
const REQUEST_JSON = JSON.stringify({
  repo: "toon-protocol/buzz",
  brief: "fixture request",
});

function baseEvent(overrides) {
  return {
    id: "d".repeat(64),
    pubkey: BUYER_PUBKEY,
    createdAt: 1_700_000_000,
    kind: 5097,
    content: "",
    tags: [],
    ...overrides,
  };
}

test("5097 request: well-formed brief and bid render a labeled request card", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 5097,
      tags: [
        ["i", "Refactor the auth module", "text"],
        ["bid", "5000000", "usdc"],
      ],
    }),
  );
  assert.equal(card.variant, "request");
  assert.equal(card.title, "Job request");
  assert.match(card.description, /Refactor the auth module/);
  assert.match(card.description, /5\.00 USDC/);
});

test("5097 request: empty/malformed tags still render a labeled card, not nothing", () => {
  const card = deriveFactoryJobCard(baseEvent({ kind: 5097, tags: [] }));
  assert.equal(card.variant, "unrecognized");
  assert.equal(card.title, "Job request");
  assert.ok(card.description.length > 0);
});

test("6097 result: completed outcome renders a labeled result card", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 6097,
      pubkey: PROVIDER_PUBKEY,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["e", QUOTE_ID, "", "reply"],
        ["p", BUYER_PUBKEY],
        ["outcome", "completed"],
        ["increment", "3", "3"],
        ["i", "https://arweave.net/abc", "url"],
        ["request", REQUEST_JSON],
      ],
    }),
  );
  assert.equal(card.variant, "result-completed");
  assert.equal(card.title, "Job result");
  assert.match(card.description, /Completed/);
  assert.match(card.description, /3 of 3/);
});

test("6097 result: abandoned-provider outcome renders distinctly from completed", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 6097,
      pubkey: PROVIDER_PUBKEY,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["e", QUOTE_ID, "", "reply"],
        ["p", BUYER_PUBKEY],
        ["outcome", "abandoned-provider"],
        ["increment", "1", "3"],
        ["request", REQUEST_JSON],
      ],
    }),
  );
  assert.equal(card.variant, "result-abandoned");
  assert.match(card.description, /Abandoned by provider/);
});

test("6097 result: empty-content/missing tags still render a labeled card", () => {
  const card = deriveFactoryJobCard(
    baseEvent({ kind: 6097, pubkey: PROVIDER_PUBKEY, tags: [] }),
  );
  assert.equal(card.variant, "unrecognized");
  assert.equal(card.title, "Job result");
});

test("6097 result: missing the reply e-tag or buyer p tag reports the reason, not just unrecognized", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 6097,
      pubkey: PROVIDER_PUBKEY,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["outcome", "completed"],
        ["increment", "3", "3"],
        ["i", "https://arweave.net/abc", "url"],
        ["request", REQUEST_JSON],
      ],
    }),
  );
  assert.equal(card.variant, "unrecognized");
  assert.match(card.description, /missing reply e-tag/);
});

test("7000 feedback: quote status renders a labeled quote card", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 7000,
      pubkey: PROVIDER_PUBKEY,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["status", "quote"],
      ],
      content: JSON.stringify({
        increments: [
          { n: 1, of: 2, milestone: "plan", priceUsdc: "1000000" },
          { n: 2, of: 2, milestone: "implement", priceUsdc: "4000000" },
        ],
      }),
    }),
  );
  assert.equal(card.variant, "quote");
  assert.equal(card.title, "Job quote");
  assert.match(card.description, /2 increments/);
  assert.match(card.description, /5\.00 USDC/);
});

test("7000 feedback: partial increment offer renders a labeled increment card", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 7000,
      pubkey: PROVIDER_PUBKEY,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["e", QUOTE_ID, "", "reply"],
        ["status", "partial"],
        ["increment", "1", "2"],
        ["i", "https://arweave.net/xyz", "url"],
        ["amount", "1000000"],
        ["condition", "e".repeat(64)],
        ["p", BUYER_PUBKEY],
      ],
    }),
  );
  assert.equal(card.variant, "partial");
  assert.match(card.description, /Increment 1 of 2/);
  assert.match(card.description, /1\.00 USDC/);
});

test("7000 feedback: processing narration renders the narration text", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 7000,
      pubkey: PROVIDER_PUBKEY,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["status", "processing"],
      ],
      content: "Running the test suite now",
    }),
  );
  assert.equal(card.variant, "processing");
  assert.match(card.description, /Running the test suite now/);
});

test("7000 feedback: processing narration with empty content still renders a card", () => {
  const card = deriveFactoryJobCard(
    baseEvent({
      kind: 7000,
      pubkey: PROVIDER_PUBKEY,
      tags: [
        ["e", ROOT_ID, "", "root"],
        ["status", "processing"],
      ],
      content: "",
    }),
  );
  assert.equal(card.variant, "processing");
  assert.ok(card.description.length > 0);
});

test("7000 feedback: malformed/empty event still renders a labeled card", () => {
  const card = deriveFactoryJobCard(
    baseEvent({ kind: 7000, pubkey: PROVIDER_PUBKEY, tags: [], content: "" }),
  );
  assert.equal(card.variant, "unrecognized");
  assert.equal(card.title, "Job update");
});
