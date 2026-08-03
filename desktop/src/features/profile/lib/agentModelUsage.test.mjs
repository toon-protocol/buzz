import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateAgentModelUsage,
  fetchAgentModelUsage,
  formatModelUsageCostUsd,
  formatTokenCount,
  parseAgentTurnMetric,
} from "./agentModelUsage.ts";

/**
 * Covers the buzz#75 Money tab's Model usage block: parsing a decrypted
 * kind:44200 NIP-AM payload, aggregating turns into a summary without
 * double-counting session-cumulative totals, and the honest-empty-state
 * rule (no events → null, never a zero).
 */

function event(overrides = {}) {
  return { id: "evt-1", created_at: 1_000, ...overrides };
}

// ── parseAgentTurnMetric ────────────────────────────────────────────────────

test("parses a well-formed NIP-AM payload", () => {
  const parsed = parseAgentTurnMetric(
    event({ id: "evt-1", created_at: 1_700_000_000 }),
    {
      harness: "buzz-agent",
      model: "claude-sonnet-5",
      sessionId: "sess-1",
      turnSeq: 3,
      turn: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
      cumulative: { inputTokens: 400, outputTokens: 150, costUsd: 0.01 },
    },
  );

  assert.deepEqual(parsed, {
    eventId: "evt-1",
    createdAt: 1_700_000_000,
    model: "claude-sonnet-5",
    sessionId: "sess-1",
    turnSeq: 3,
    turn: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
    cumulative: { inputTokens: 400, outputTokens: 150, costUsd: 0.01 },
  });
});

test("rejects a payload missing the required harness field", () => {
  const parsed = parseAgentTurnMetric(event(), {
    model: "claude-sonnet-5",
    turn: { inputTokens: 100 },
  });
  assert.equal(parsed, null);
});

test("rejects a non-object decrypted payload", () => {
  assert.equal(parseAgentTurnMetric(event(), null), null);
  assert.equal(parseAgentTurnMetric(event(), "not json"), null);
});

test("treats negative or non-finite token/cost fields as absent, not corrupting the aggregate", () => {
  const parsed = parseAgentTurnMetric(event(), {
    harness: "goose",
    turn: {
      inputTokens: -5,
      outputTokens: Number.NaN,
      costUsd: Number.POSITIVE_INFINITY,
    },
  });

  assert.deepEqual(parsed.turn, {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
});

test("a turn/cumulative field left null (not omitted) parses as null, not zero", () => {
  const parsed = parseAgentTurnMetric(event(), {
    harness: "goose",
    turn: null,
    cumulative: null,
  });
  assert.equal(parsed.turn, null);
  assert.equal(parsed.cumulative, null);
});

// ── aggregateAgentModelUsage ─────────────────────────────────────────────────

test("no metrics yields null — the honest empty state, not a zero", () => {
  assert.equal(aggregateAgentModelUsage([]), null);
});

test("a single turn's cumulative counts become the summary", () => {
  const summary = aggregateAgentModelUsage([
    {
      eventId: "e1",
      createdAt: 1_000,
      model: "claude-sonnet-5",
      sessionId: "sess-1",
      turnSeq: 1,
      turn: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
      cumulative: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
    },
  ]);

  assert.deepEqual(summary, {
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.002,
    turnCount: 1,
    lastModel: "claude-sonnet-5",
    lastActivityAt: 1_000,
  });
});

test("sums only the LAST turn's cumulative per session — never double-counts", () => {
  // Three turns in one session: cumulative already folds in every prior turn,
  // so the summary must equal turn 3's cumulative, not the sum of all three.
  const summary = aggregateAgentModelUsage([
    {
      eventId: "e1",
      createdAt: 1_000,
      model: "m",
      sessionId: "sess-1",
      turnSeq: 1,
      turn: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
      cumulative: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
    },
    {
      eventId: "e2",
      createdAt: 2_000,
      model: "m",
      sessionId: "sess-1",
      turnSeq: 2,
      turn: { inputTokens: 200, outputTokens: 80, costUsd: 0.002 },
      cumulative: { inputTokens: 300, outputTokens: 130, costUsd: 0.003 },
    },
    {
      eventId: "e3",
      createdAt: 3_000,
      model: "m",
      sessionId: "sess-1",
      turnSeq: 3,
      turn: { inputTokens: 50, outputTokens: 20, costUsd: 0.0005 },
      cumulative: { inputTokens: 350, outputTokens: 150, costUsd: 0.0035 },
    },
  ]);

  assert.equal(summary.totalInputTokens, 350);
  assert.equal(summary.totalOutputTokens, 150);
  assert.equal(summary.totalCostUsd, 0.0035);
  assert.equal(summary.turnCount, 3);
  assert.equal(summary.lastActivityAt, 3_000);
});

test("sums across independent sessions", () => {
  const summary = aggregateAgentModelUsage([
    {
      eventId: "e1",
      createdAt: 1_000,
      model: "m",
      sessionId: "sess-1",
      turnSeq: 1,
      turn: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
      cumulative: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
    },
    {
      eventId: "e2",
      createdAt: 2_000,
      model: "m",
      sessionId: "sess-2",
      turnSeq: 1,
      turn: { inputTokens: 40, outputTokens: 10, costUsd: 0.0004 },
      cumulative: { inputTokens: 40, outputTokens: 10, costUsd: 0.0004 },
    },
  ]);

  assert.equal(summary.totalInputTokens, 140);
  assert.equal(summary.totalOutputTokens, 60);
  assert.ok(Math.abs(summary.totalCostUsd - 0.0014) < 1e-9);
  assert.equal(summary.turnCount, 2);
});

test("falls back to summing turn deltas for events without a sessionId", () => {
  const summary = aggregateAgentModelUsage([
    {
      eventId: "e1",
      createdAt: 1_000,
      model: "m",
      sessionId: null,
      turnSeq: null,
      turn: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
      cumulative: null,
    },
    {
      eventId: "e2",
      createdAt: 2_000,
      model: "m",
      sessionId: null,
      turnSeq: null,
      turn: { inputTokens: 20, outputTokens: 8, costUsd: 0.0002 },
      cumulative: null,
    },
  ]);

  assert.equal(summary.totalInputTokens, 30);
  assert.equal(summary.totalOutputTokens, 13);
});

test("an unreliable delta (turn null, cumulative present) still contributes via cumulative", () => {
  const summary = aggregateAgentModelUsage([
    {
      eventId: "e1",
      createdAt: 1_000,
      model: "m",
      sessionId: "sess-1",
      turnSeq: 1,
      turn: null,
      cumulative: { inputTokens: 500, outputTokens: 200, costUsd: 0.02 },
    },
  ]);

  assert.equal(summary.totalInputTokens, 500);
  assert.equal(summary.totalOutputTokens, 200);
});

test("null cost across every turn surfaces as null, not zero", () => {
  const summary = aggregateAgentModelUsage([
    {
      eventId: "e1",
      createdAt: 1_000,
      model: "m",
      sessionId: "sess-1",
      turnSeq: 1,
      turn: { inputTokens: 10, outputTokens: 5, costUsd: null },
      cumulative: { inputTokens: 10, outputTokens: 5, costUsd: null },
    },
  ]);

  assert.equal(summary.totalCostUsd, null);
  assert.equal(summary.totalInputTokens, 10);
});

test("lastModel/lastActivityAt reflect the most recent event across sessions", () => {
  const summary = aggregateAgentModelUsage([
    {
      eventId: "e1",
      createdAt: 5_000,
      model: "old-model",
      sessionId: "sess-1",
      turnSeq: 1,
      turn: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      cumulative: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    },
    {
      eventId: "e2",
      createdAt: 9_000,
      model: "new-model",
      sessionId: "sess-2",
      turnSeq: 1,
      turn: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      cumulative: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    },
  ]);

  assert.equal(summary.lastModel, "new-model");
  assert.equal(summary.lastActivityAt, 9_000);
});

// ── fetchAgentModelUsage ─────────────────────────────────────────────────────

test("fetchAgentModelUsage aggregates across decrypted events, scoped by agent/owner", async () => {
  let capturedAgent;
  let capturedOwner;

  const summary = await fetchAgentModelUsage("AgentPubkey", "OwnerPubkey", {
    fetchEvents: async (agentPubkey, ownerPubkey) => {
      capturedAgent = agentPubkey;
      capturedOwner = ownerPubkey;
      return [
        event({ id: "e1", created_at: 1_000 }),
        event({ id: "e2", created_at: 2_000 }),
      ];
    },
    decryptEvent: async (evt) => ({
      harness: "buzz-agent",
      model: "claude-sonnet-5",
      sessionId: `sess-${evt.id}`,
      turnSeq: 1,
      turn: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      cumulative: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    }),
  });

  assert.equal(capturedAgent, "AgentPubkey");
  assert.equal(capturedOwner, "OwnerPubkey");
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.totalInputTokens, 20);
});

test("fetchAgentModelUsage drops an event that fails to decrypt instead of failing the whole fetch", async () => {
  const summary = await fetchAgentModelUsage("agent", "owner", {
    fetchEvents: async () => [
      event({ id: "good", created_at: 1_000 }),
      event({ id: "bad", created_at: 2_000 }),
    ],
    decryptEvent: async (evt) => {
      if (evt.id === "bad") throw new Error("decrypt failed");
      return {
        harness: "buzz-agent",
        sessionId: "sess-1",
        turnSeq: 1,
        turn: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        cumulative: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      };
    },
  });

  assert.equal(summary.turnCount, 1);
});

test("fetchAgentModelUsage returns null (not an empty-object summary) when no events exist", async () => {
  const summary = await fetchAgentModelUsage("agent", "owner", {
    fetchEvents: async () => [],
    decryptEvent: async () => ({}),
  });

  assert.equal(summary, null);
});

// ── Formatting ────────────────────────────────────────────────────────────────

test("formatTokenCount groups with locale separators", () => {
  assert.equal(formatTokenCount(12345), "12,345");
  assert.equal(formatTokenCount(0), "0");
});

test("formatModelUsageCostUsd widens to 4dp under a cent", () => {
  assert.equal(formatModelUsageCostUsd(0.0023), "$0.0023");
  assert.equal(formatModelUsageCostUsd(1.5), "$1.50");
  assert.equal(formatModelUsageCostUsd(0), "$0.00");
});
