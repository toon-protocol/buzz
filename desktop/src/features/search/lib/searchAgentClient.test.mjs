import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentSearchBody,
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

// tauri.ts imports `invoke` from @tauri-apps/api/core, which calls
// `window.__TAURI_INTERNALS__.invoke`. searchViaAgent now signs every
// request (buzz#179), so every test that reaches it needs this stub —
// mirrors invites.test.mjs's setupTauriStubs.
function setupTauriStubs(
  authEvent = {
    id: "x",
    sig: "y",
    pubkey: "z",
    kind: 27235,
    created_at: 1,
    tags: [],
  },
) {
  globalThis.window = globalThis.window ?? {};
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command === "sign_event") return JSON.stringify(authEvent);
      throw new Error(`Unexpected Tauri command: ${command}`);
    },
  };
}

function teardownTauriStubs() {
  delete globalThis.window.__TAURI_INTERNALS__;
}

test("the query body carries the text, the scope, and the limit", () => {
  assert.deepEqual(
    buildAgentSearchBody({ q: "deploy token", limit: 12 }, [MEMBER, OTHER]),
    {
      q: "deploy token",
      channels: [MEMBER, OTHER],
      limit: 12,
      authors: undefined,
      since: undefined,
      until: undefined,
    },
  );
});

test("the query body carries authors/since/until when the operators set them", () => {
  assert.deepEqual(
    buildAgentSearchBody(
      {
        q: "deploy",
        authors: ["aa".repeat(32)],
        since: 100,
        until: 200,
      },
      [MEMBER],
    ),
    {
      q: "deploy",
      channels: [MEMBER],
      limit: 20,
      authors: ["aa".repeat(32)],
      since: 100,
      until: 200,
    },
  );
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

test("the request is a signed POST carrying the query body", async (t) => {
  setupTauriStubs();
  try {
    let capturedUrl;
    let capturedInit;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ hits: [agentHit()] }), {
        status: 200,
      });
    });

    await searchViaAgent(BASE, { q: "deploy", limit: 5 }, [MEMBER]);

    assert.equal(capturedUrl, `${BASE}/search`);
    assert.equal(capturedInit.method, "POST");
    assert.match(capturedInit.headers.Authorization, /^Nostr /);
    assert.equal(capturedInit.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(capturedInit.body), {
      q: "deploy",
      channels: [MEMBER],
      limit: 5,
    });
  } finally {
    teardownTauriStubs();
  }
});

test("the in: operator narrows the scope and can never widen it", async (t) => {
  setupTauriStubs();
  try {
    let requestedBody = null;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requestedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ hits: [agentHit()] }), {
        status: 200,
      });
    });

    await searchViaAgent(BASE, { q: "deploy", channelId: MEMBER }, [
      MEMBER,
      OTHER,
    ]);
    assert.deepEqual(requestedBody.channels, [MEMBER]);

    // A channel the client holds no key for cannot be asked about, even when the
    // operator names it explicitly: the intersection is empty, so nothing is sent.
    const outside = await searchViaAgent(
      BASE,
      { q: "deploy", channelId: "00000000-0000-0000-0000-000000000000" },
      [MEMBER],
    );
    assert.deepEqual(outside, { hits: [], found: 0 });
  } finally {
    teardownTauriStubs();
  }
});

test("a non-200 from the agent is an error the query surfaces", async (t) => {
  setupTauriStubs();
  try {
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
  } finally {
    teardownTauriStubs();
  }
});
