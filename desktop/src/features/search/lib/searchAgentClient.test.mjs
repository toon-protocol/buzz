import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentSearchUrl,
  parseAgentHit,
  parseAgentResponse,
  searchViaAgent,
} from "./searchAgentClient.ts";

const BASE = "http://127.0.0.1:8788";
const MEMBER = "6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b";
const OTHER = "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a";

function agentHit(overrides = {}) {
  return {
    eventId: "a".repeat(64),
    content: "the deploy token is in the vault",
    kind: 9,
    pubkey: "b".repeat(64),
    channelId: MEMBER,
    channelName: null,
    createdAt: 1_700_000_100,
    score: 1.25,
    ...overrides,
  };
}

test("the query URL carries the text, the scope, and the limit", () => {
  const url = new URL(
    buildAgentSearchUrl(BASE, { q: "deploy token", limit: 12 }, [
      MEMBER,
      OTHER,
    ]),
  );
  assert.equal(url.origin, BASE);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "deploy token");
  assert.equal(url.searchParams.get("channels"), `${MEMBER},${OTHER}`);
  assert.equal(url.searchParams.get("limit"), "12");
});

test("an agent hit maps onto the SearchHit shape the UI already renders", () => {
  assert.deepEqual(parseAgentHit(agentHit()), {
    eventId: "a".repeat(64),
    content: "the deploy token is in the vault",
    kind: 9,
    pubkey: "b".repeat(64),
    channelId: MEMBER,
    channelName: null,
    createdAt: 1_700_000_100,
    score: 1.25,
  });
});

test("one unparseable row costs that row, not the whole result set", () => {
  const response = parseAgentResponse({
    hits: [
      agentHit(),
      { content: "no event id" },
      agentHit({ eventId: "c".repeat(64) }),
    ],
  });
  assert.equal(response.found, 2);
  assert.deepEqual(
    response.hits.map((hit) => hit.eventId),
    ["a".repeat(64), "c".repeat(64)],
  );
});

test("a response that is not an agent response is empty, not a throw", () => {
  assert.deepEqual(parseAgentResponse(null), { hits: [], found: 0 });
  assert.deepEqual(parseAgentResponse({ hits: "nope" }), {
    hits: [],
    found: 0,
  });
});

test("an empty membership scope never reaches the agent", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("the agent must not be called with an empty scope");
  });
  const response = await searchViaAgent(BASE, { q: "deploy" }, []);
  assert.deepEqual(response, { hits: [], found: 0 });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("the in: operator narrows the scope and can never widen it", async (t) => {
  let requested = null;
  t.mock.method(globalThis, "fetch", async (url) => {
    requested = new URL(url);
    return new Response(JSON.stringify({ hits: [agentHit()] }), {
      status: 200,
    });
  });

  await searchViaAgent(BASE, { q: "deploy", channelId: MEMBER }, [
    MEMBER,
    OTHER,
  ]);
  assert.equal(requested.searchParams.get("channels"), MEMBER);

  // A channel the client holds no key for cannot be asked about, even when the
  // operator names it explicitly: the intersection is empty, so nothing is sent.
  const outside = await searchViaAgent(
    BASE,
    { q: "deploy", channelId: "00000000-0000-0000-0000-000000000000" },
    [MEMBER],
  );
  assert.deepEqual(outside, { hits: [], found: 0 });
});

test("a non-200 from the agent is an error the query surfaces", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("boom", {
        status: 500,
        statusText: "Internal Server Error",
      }),
  );
  await assert.rejects(
    () => searchViaAgent(BASE, { q: "deploy" }, [MEMBER]),
    /returned 500/,
  );
});
