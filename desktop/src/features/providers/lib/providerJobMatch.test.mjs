import assert from "node:assert/strict";
import test from "node:test";

import { matchesProviderCapability } from "./providerJobMatch.ts";

function job(overrides = {}) {
  return {
    eventId: "e",
    buyerPubkey: "buyer",
    createdAt: 0,
    brief: "Do a thing",
    bidBaseUnits: 1_000_000n,
    repo: null,
    target: null,
    constraints: null,
    outputMimeType: null,
    targetProviderPubkey: null,
    ...overrides,
  };
}

test("disabled capability matches nothing, regardless of repo filter", () => {
  const settings = { enabled: false, description: "", repoFilter: [] };
  assert.equal(matchesProviderCapability(job(), settings), false);
});

test("enabled with an empty repo filter matches any job, including one with no repo", () => {
  const settings = { enabled: true, description: "", repoFilter: [] };
  assert.equal(matchesProviderCapability(job(), settings), true);
  assert.equal(
    matchesProviderCapability(job({ repo: "toon-protocol/buzz" }), settings),
    true,
  );
});

test("a non-empty repo filter only matches a job naming a listed repo", () => {
  const settings = {
    enabled: true,
    description: "",
    repoFilter: ["toon-protocol/buzz"],
  };
  assert.equal(
    matchesProviderCapability(job({ repo: "toon-protocol/buzz" }), settings),
    true,
  );
  assert.equal(
    matchesProviderCapability(job({ repo: "other/repo" }), settings),
    false,
  );
  assert.equal(matchesProviderCapability(job({ repo: null }), settings), false);
});
