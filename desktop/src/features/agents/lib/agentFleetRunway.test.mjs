import assert from "node:assert/strict";
import test from "node:test";

import {
  agentFleetRunwaySortWeight,
  countLowFundsAgents,
  deriveAgentFleetRunwayBadge,
  sortByFleetRunway,
} from "./agentFleetRunway.ts";

/**
 * Covers buzz#76: runway badges on AgentIdentityCard + the sidebar
 * low-funds alert. Reuses buzz#80's `NetworkSpendState`/`agentNetworkFlow`
 * runway derivation — these tests exercise the fleet-glance layer built on
 * top of it (badge thresholds, sort order, low-funds count), including the
 * "demonstrated against a deliberately drained agent" acceptance criterion
 * via a synthetic depleted/near-depleted `NetworkFlowRead`.
 */

const READ = {
  depositBaseUnits: 10_000_000n,
  owedBaseUnits: 4_000_000n,
  creditedBaseUnits: 0n,
  burnRateBaseUnitsPerSec: 100,
  incomeRateBaseUnitsPerSec: 0,
  incomeSampleCount: 0,
};

function quoted(read) {
  return { kind: "quoted", read, source: "local", hasBurnSample: true };
}

test("unavailable/relay/pending states never fabricate a badge", () => {
  assert.equal(deriveAgentFleetRunwayBadge({ kind: "relay" }), null);
  assert.equal(deriveAgentFleetRunwayBadge({ kind: "pending" }), null);
  assert.equal(deriveAgentFleetRunwayBadge({ kind: "unavailable" }), null);
});

test("a deliberately drained agent (depleted balance) reads critical", () => {
  const badge = deriveAgentFleetRunwayBadge(
    quoted({ ...READ, depositBaseUnits: 4_000_000n }),
  );
  assert.deepEqual(badge, { level: "critical", label: "Out of funds" });
});

test("runway under the critical threshold (hours left) reads critical", () => {
  // 6,000,000 remaining / 100 per sec = 60,000s = ~16.7 hours, under 1 day.
  const badge = deriveAgentFleetRunwayBadge(quoted(READ));
  assert.equal(badge?.level, "critical");
  assert.match(badge.label, /hr/);
});

test("runway under the warning threshold but over critical reads warning", () => {
  // Slower burn: 6,000,000 / 10 per sec = 600,000s = ~6.9 days... too long.
  // Use a burn rate that lands runway at ~2 days (172,800s).
  const read = { ...READ, burnRateBaseUnitsPerSec: 6_000_000 / 172_800 };
  const badge = deriveAgentFleetRunwayBadge(quoted(read));
  assert.equal(badge?.level, "warning");
  assert.match(badge.label, /day/);
});

test("healthy runway (well over the warning threshold) shows no badge", () => {
  const read = { ...READ, burnRateBaseUnitsPerSec: 1 };
  const badge = deriveAgentFleetRunwayBadge(quoted(read));
  assert.equal(badge, null);
});

test("self-funding agents show no badge — not a low-funds concern", () => {
  const read = {
    ...READ,
    incomeRateBaseUnitsPerSec: 150,
    incomeSampleCount: 5,
  };
  const badge = deriveAgentFleetRunwayBadge(quoted(read));
  assert.equal(badge, null);
});

test("sort weight ranks critical ahead of warning ahead of everything else", () => {
  const critical = { level: "critical", label: "Out of funds" };
  const warning = { level: "warning", label: "2 days left" };
  assert.ok(
    agentFleetRunwaySortWeight(critical) < agentFleetRunwaySortWeight(warning),
  );
  assert.ok(
    agentFleetRunwaySortWeight(warning) < agentFleetRunwaySortWeight(null),
  );
});

test("sortByFleetRunway surfaces a deliberately drained agent ahead of healthy ones", () => {
  const agents = [
    { id: "healthy-a", badge: null },
    { id: "healthy-b", badge: null },
    { id: "warning", badge: { level: "warning", label: "2 days left" } },
    { id: "drained", badge: { level: "critical", label: "Out of funds" } },
  ];
  const sorted = sortByFleetRunway(agents, (agent) => agent.badge);
  assert.deepEqual(
    sorted.map((agent) => agent.id),
    ["drained", "warning", "healthy-a", "healthy-b"],
  );
});

test("sortByFleetRunway is stable — ties keep their original relative order", () => {
  const agents = [
    { id: "b", badge: null },
    { id: "a", badge: null },
  ];
  const sorted = sortByFleetRunway(agents, (agent) => agent.badge);
  assert.deepEqual(
    sorted.map((agent) => agent.id),
    ["b", "a"],
  );
});

test("countLowFundsAgents counts critical and warning, ignores everything else", () => {
  const count = countLowFundsAgents([
    { level: "critical", label: "Out of funds" },
    null,
    { level: "warning", label: "2 days left" },
    null,
  ]);
  assert.equal(count, 2);
});

test("countLowFundsAgents is zero when nothing needs attention", () => {
  assert.equal(countLowFundsAgents([null, null]), 0);
});
