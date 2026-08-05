import assert from "node:assert/strict";
import test from "node:test";

import {
  findAgentEvmChannelId,
  readAgentsNetworkFlowStatus,
} from "./agentClaimStateRead.ts";

/**
 * Covers buzz#109 / ADR 0007: per-agent claim-state reads with no
 * `toon-clientd`/`buzz-acp` involvement at all — every dependency this
 * module needs is injected (RPC fetch, identity derivation, challenge
 * signing, the connector edge client), so a passing test here is itself
 * the proof that the read never reaches for an agent's own daemon.
 */

const TOKEN_NETWORK = "0xTokenNetwork";
const CHANNEL_A = `0x${"a".repeat(64)}`;
const CHANNEL_B = `0x${"b".repeat(64)}`;

function logsFetch(byQueryShape) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const topics = body.params[0].topics;
    // A participant1 query has 3 topic slots ([sig, null, addr]); a
    // participant2 query has 4 ([sig, null, null, addr]) — see
    // agentClaimStateRead.ts's two-query doc comment.
    const shape = topics.length === 3 ? "participant1" : "participant2";
    const address = topics[topics.length - 1];
    const logs = byQueryShape(shape, address);
    return { json: async () => ({ result: logs }) };
  };
}

function log(channelId, blockNumber) {
  return {
    topics: ["0xsig", channelId, "0xp1", "0xp2"],
    blockNumber,
  };
}

/** Mirrors agentClaimStateRead.ts's private `addressTopic` so a mock fetch can match on the same padded topic the module actually queries with. */
function topicFor(address) {
  const hex = address.toLowerCase().replace(/^0x/, "").padStart(40, "0");
  return `0x${"0".repeat(24)}${hex}`;
}

test("findAgentEvmChannelId finds a channel where the agent was participant1", async () => {
  const fetchImpl = logsFetch((shape) =>
    shape === "participant1" ? [log(CHANNEL_A, "0x1")] : [],
  );
  const channelId = await findAgentEvmChannelId({
    rpcUrl: "https://rpc.example",
    tokenNetworkAddress: TOKEN_NETWORK,
    agentAddress: "0xAgent",
    fetchImpl,
  });
  assert.equal(channelId, CHANNEL_A);
});

test("findAgentEvmChannelId finds a channel where the agent was participant2", async () => {
  const fetchImpl = logsFetch((shape) =>
    shape === "participant2" ? [log(CHANNEL_B, "0x1")] : [],
  );
  const channelId = await findAgentEvmChannelId({
    rpcUrl: "https://rpc.example",
    tokenNetworkAddress: TOKEN_NETWORK,
    agentAddress: "0xAgent",
    fetchImpl,
  });
  assert.equal(channelId, CHANNEL_B);
});

test("findAgentEvmChannelId returns null when the agent has never opened a channel", async () => {
  const fetchImpl = logsFetch(() => []);
  const channelId = await findAgentEvmChannelId({
    rpcUrl: "https://rpc.example",
    tokenNetworkAddress: TOKEN_NETWORK,
    agentAddress: "0xAgent",
    fetchImpl,
  });
  assert.equal(channelId, null);
});

test("findAgentEvmChannelId prefers the most recently opened channel when more than one exists", async () => {
  const fetchImpl = logsFetch((shape) =>
    shape === "participant1"
      ? [log(CHANNEL_A, "0x1"), log(CHANNEL_B, "0x5")]
      : [],
  );
  const channelId = await findAgentEvmChannelId({
    rpcUrl: "https://rpc.example",
    tokenNetworkAddress: TOKEN_NETWORK,
    agentAddress: "0xAgent",
    fetchImpl,
  });
  assert.equal(channelId, CHANNEL_B);
});

test("findAgentEvmChannelId throws a legible error on an RPC error response", async () => {
  const fetchImpl = async () => ({
    json: async () => ({ error: { message: "rate limited" } }),
  });
  await assert.rejects(
    findAgentEvmChannelId({
      rpcUrl: "https://rpc.example",
      tokenNetworkAddress: TOKEN_NETWORK,
      agentAddress: "0xAgent",
      fetchImpl,
    }),
    /rate limited/,
  );
});

const BASE_CONFIG = {
  mnemonic: "test mnemonic",
  chain: "evm:84532",
  chainRpcUrl: "https://rpc.example",
  tokenNetwork: TOKEN_NETWORK,
  connectorUrl: "https://connector.example",
};

function stubDeps(overrides = {}) {
  return {
    fetchImpl: logsFetch(() => []),
    deriveIdentity: async (_mnemonic, accountIndex) => ({
      evm: {
        address: `0xAgent${accountIndex}`,
        privateKey: new Uint8Array([accountIndex]),
      },
    }),
    signChallenge: async (_privateKey, params) =>
      `signature-for-${params.channelId}`,
    ...overrides,
  };
}

test("readAgentsNetworkFlowStatus reads every agent in ONE batched getClaimState call", async () => {
  const calls = [];
  const edgeClient = {
    getClaimState: async (endpoint, entries) => {
      calls.push({ endpoint, entries });
      return entries.map((entry) => ({
        ok: true,
        depositTotal: entry.channelId === CHANNEL_A ? "10000000" : "20000000",
        cumulativeClaimed: "4000000",
      }));
    },
  };
  const fetchImpl = logsFetch((shape, address) => {
    if (shape !== "participant1") return [];
    if (address === topicFor("0xAgent0")) return [log(CHANNEL_A, "0x1")];
    if (address === topicFor("0xAgent1")) return [log(CHANNEL_B, "0x1")];
    return [];
  });

  const results = await readAgentsNetworkFlowStatus(
    BASE_CONFIG,
    [
      { pubkey: "agent-0", accountIndex: 0 },
      { pubkey: "agent-1", accountIndex: 1 },
    ],
    stubDeps({ edgeClient, fetchImpl }),
  );

  assert.equal(
    calls.length,
    1,
    "exactly one getClaimState request for both agents",
  );
  assert.equal(calls[0].entries.length, 2);
  assert.equal(calls[0].endpoint, BASE_CONFIG.connectorUrl);

  assert.deepEqual(results.get("agent-0"), {
    channelId: CHANNEL_A,
    source: "claim-state",
    depositTotalBaseUnits: 10_000_000n,
    cumulativeClaimedBaseUnits: 4_000_000n,
    creditedBaseUnits: 0n,
  });
  assert.deepEqual(results.get("agent-1"), {
    channelId: CHANNEL_B,
    source: "claim-state",
    depositTotalBaseUnits: 20_000_000n,
    cumulativeClaimedBaseUnits: 4_000_000n,
    creditedBaseUnits: 0n,
  });
});

test("readAgentsNetworkFlowStatus reports unavailable, never fabricated, for an agent with no discovered channel", async () => {
  const calls = [];
  const edgeClient = {
    getClaimState: async (_endpoint, entries) => {
      calls.push(entries);
      return entries.map(() => ({
        ok: true,
        depositTotal: "1",
        cumulativeClaimed: "0",
      }));
    },
  };
  const results = await readAgentsNetworkFlowStatus(
    BASE_CONFIG,
    [{ pubkey: "agent-no-channel", accountIndex: 7 }],
    stubDeps({ edgeClient, fetchImpl: logsFetch(() => []) }),
  );

  assert.equal(results.get("agent-no-channel"), null);
  assert.equal(
    calls.length,
    0,
    "an agent with no channel is never sent to the connector",
  );
});

test("readAgentsNetworkFlowStatus omits a channel-having agent from the batch entries when another agent has none, but still asks for the one that does", async () => {
  const fetchImpl = logsFetch((shape, address) =>
    address === topicFor("0xAgent0") && shape === "participant1"
      ? [log(CHANNEL_A, "0x1")]
      : [],
  );
  const edgeClient = {
    getClaimState: async (_endpoint, entries) =>
      entries.map(() => ({
        ok: true,
        depositTotal: "5000000",
        cumulativeClaimed: "0",
      })),
  };

  const results = await readAgentsNetworkFlowStatus(
    BASE_CONFIG,
    [
      { pubkey: "has-channel", accountIndex: 0 },
      { pubkey: "no-channel", accountIndex: 1 },
    ],
    stubDeps({ edgeClient, fetchImpl }),
  );

  assert.equal(results.get("no-channel"), null);
  assert.equal(results.get("has-channel")?.depositTotalBaseUnits, 5_000_000n);
});

test("readAgentsNetworkFlowStatus reports unavailable for every agent when the connector could not verify a challenge", async () => {
  const fetchImpl = logsFetch((shape) =>
    shape === "participant1" ? [log(CHANNEL_A, "0x1")] : [],
  );
  const edgeClient = {
    getClaimState: async (_endpoint, entries) =>
      entries.map(() => ({ ok: false })),
  };

  const results = await readAgentsNetworkFlowStatus(
    BASE_CONFIG,
    [{ pubkey: "agent-0", accountIndex: 0 }],
    stubDeps({ edgeClient, fetchImpl }),
  );

  assert.equal(results.get("agent-0"), null);
});

test("readAgentsNetworkFlowStatus reports unavailable for every agent on a non-EVM chain — Solana is out of scope", async () => {
  const results = await readAgentsNetworkFlowStatus(
    { ...BASE_CONFIG, chain: "solana:devnet" },
    [{ pubkey: "agent-0", accountIndex: 0 }],
    stubDeps(),
  );
  assert.equal(results.get("agent-0"), null);
});

test("readAgentsNetworkFlowStatus reports unavailable for every agent when there is no payment mnemonic", async () => {
  const results = await readAgentsNetworkFlowStatus(
    { ...BASE_CONFIG, mnemonic: null },
    [{ pubkey: "agent-0", accountIndex: 0 }],
    stubDeps(),
  );
  assert.equal(results.get("agent-0"), null);
});

test("readAgentsNetworkFlowStatus returns an empty map for an empty agent list, without touching the network", async () => {
  let fetchCalled = false;
  const results = await readAgentsNetworkFlowStatus(BASE_CONFIG, [], {
    ...stubDeps(),
    fetchImpl: async () => {
      fetchCalled = true;
      return { json: async () => ({ result: [] }) };
    },
  });
  assert.equal(results.size, 0);
  assert.equal(fetchCalled, false);
});

test("readAgentsNetworkFlowStatus succeeds with the agent's own process entirely absent (buzz#109's core AC)", async () => {
  // Nothing in this test — or in the module under test — stubs, mocks, or
  // otherwise references a `buzz-acp` process or a `toon-clientd` sidecar.
  // Every dependency `readAgentsNetworkFlowStatus` uses is: an RPC fetch to
  // a public chain node, the owner's own mnemonic (already held by this
  // process), and a request to the connector's public claim-state endpoint.
  // A passing read here, for an agent identity that this test never spun up
  // any process for, is the proof the design needs no live agent to answer.
  const fetchImpl = logsFetch((shape) =>
    shape === "participant1" ? [log(CHANNEL_A, "0x1")] : [],
  );
  const edgeClient = {
    getClaimState: async (_endpoint, entries) =>
      entries.map(() => ({
        ok: true,
        depositTotal: "3000000",
        cumulativeClaimed: "1000000",
      })),
  };

  const results = await readAgentsNetworkFlowStatus(
    BASE_CONFIG,
    [{ pubkey: "stopped-agent", accountIndex: 9 }],
    stubDeps({ edgeClient, fetchImpl }),
  );

  assert.equal(results.get("stopped-agent")?.depositTotalBaseUnits, 3_000_000n);
});
