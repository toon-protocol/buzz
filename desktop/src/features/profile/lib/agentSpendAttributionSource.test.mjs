import assert from "node:assert/strict";
import test from "node:test";

import { fetchObservedAgentEvents } from "./agentSpendAttribution.ts";

function relayEvent({ id, kind, createdAt, channelId }) {
  return {
    id,
    pubkey: "agent-pubkey",
    kind,
    created_at: createdAt,
    tags: channelId ? [["h", channelId]] : [],
    content: "",
    sig: "",
  };
}

test("fetchObservedAgentEvents asks the relay for this agent's paid-write kinds only", async () => {
  let requestedAgentPubkey = null;
  const events = await fetchObservedAgentEvents("Agent-Pubkey", {
    fetchEvents: (agentPubkey) => {
      requestedAgentPubkey = agentPubkey;
      return Promise.resolve([
        relayEvent({ id: "1", kind: 9, createdAt: 100, channelId: "general" }),
      ]);
    },
  });

  assert.equal(requestedAgentPubkey, "Agent-Pubkey");
  assert.deepEqual(events, [
    { eventId: "1", channelId: "general", kind: 9, createdAt: 100 },
  ]);
});

test("fetchObservedAgentEvents drops events with no channel tag", async () => {
  const events = await fetchObservedAgentEvents("agent-pubkey", {
    fetchEvents: () =>
      Promise.resolve([
        relayEvent({ id: "1", kind: 9, createdAt: 100, channelId: null }),
      ]),
  });

  assert.deepEqual(events, []);
});
