import assert from "node:assert/strict";
import test from "node:test";

import {
  compareFactoryJobQuotes,
  gatePassRateLabel,
} from "./factoryJobQuoteCompare.ts";

function quote(overrides = {}) {
  return {
    eventId: "quote-1",
    providerPubkey: "provider-1",
    createdAt: 1_700_000_000,
    rootJobId: "job-1",
    status: "quote",
    increments: [
      { n: 1, of: 1, milestone: "implement", priceUsdcBaseUnits: 5_000_000n },
    ],
    ...overrides,
  };
}

test("an established provider and a cold-start one land in separate groups", () => {
  const established = quote({
    eventId: "q-established",
    providerPubkey: "veteran",
  });
  const cold = quote({ eventId: "q-cold", providerPubkey: "newcomer" });

  const comparison = compareFactoryJobQuotes(
    [established, cold],
    10_000_000n,
    new Map([["veteran", { jobsCompleted: 12, gatePassRate: 0.9 }]]),
  );

  assert.equal(comparison.established.length, 1);
  assert.equal(comparison.established[0].providerPubkey, "veteran");
  assert.equal(comparison.coldStart.length, 1);
  assert.equal(comparison.coldStart[0].providerPubkey, "newcomer");
  // Cold-start providers are never silently dropped from the comparison.
  assert.equal(comparison.coldStart[0].reputation, null);
});

test("each group sorts cheapest-first, then by earliest quote", () => {
  const pricier = quote({
    eventId: "q-pricier",
    providerPubkey: "a",
    increments: [
      { n: 1, of: 1, milestone: "implement", priceUsdcBaseUnits: 9_000_000n },
    ],
  });
  const cheaper = quote({
    eventId: "q-cheaper",
    providerPubkey: "b",
    increments: [
      { n: 1, of: 1, milestone: "implement", priceUsdcBaseUnits: 1_000_000n },
    ],
  });

  const comparison = compareFactoryJobQuotes(
    [pricier, cheaper],
    10_000_000n,
    new Map(),
  );

  assert.deepEqual(
    comparison.coldStart.map((row) => row.eventId),
    ["q-cheaper", "q-pricier"],
  );
});

test("a schedule summing above the bid cap is flagged, not silently accepted", () => {
  const overBid = quote({
    increments: [
      { n: 1, of: 1, milestone: "implement", priceUsdcBaseUnits: 6_000_000n },
    ],
  });
  const comparison = compareFactoryJobQuotes([overBid], 5_000_000n, new Map());
  assert.equal(comparison.coldStart[0].exceedsBid, true);
});

test("gate-pass rate is always labelled as conformance, not quality", () => {
  assert.equal(
    gatePassRateLabel(0.875),
    "88% gate-pass rate (conformance, not quality)",
  );
  assert.equal(gatePassRateLabel(null), "No completed jobs yet");
});
