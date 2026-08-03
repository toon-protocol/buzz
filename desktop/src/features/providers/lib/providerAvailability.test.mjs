import assert from "node:assert/strict";
import test from "node:test";

import {
  canQuoteJobs,
  deriveProviderAvailability,
  providerAvailabilityCaption,
  refreshIntervalForLease,
} from "./providerAvailability.ts";

/**
 * Covers buzz#84's freshness invariant (toon-meta#262 decision 12): never
 * advertise a provider as available for longer than it stays routable on the
 * connector, and a dropped session must cost reachability only — never the
 * channel, balance, nonce position or reputation. Pure-function tests in the
 * `huddleFeeQuote` mold — no DOM, no live connector.
 */

test("the refresh cadence mirrors the mesh's 45s/120s reference ratio", () => {
  assert.equal(refreshIntervalForLease(120_000), 45_000);
  assert.equal(refreshIntervalForLease(60_000), 22_500);
});

test("advertising off reads as unadvertised regardless of session state", () => {
  const state = deriveProviderAvailability({
    advertisingEnabled: false,
    sessionConnected: true,
    lastAdvertisedAtMs: 1_000,
    nowMs: 1_000,
    sessionLeaseTtlMs: 120_000,
  });

  assert.deepEqual(state, { kind: "unadvertised" });
  assert.equal(canQuoteJobs(state), false);
});

test("advertising on with no publish yet is pending, not available", () => {
  const state = deriveProviderAvailability({
    advertisingEnabled: true,
    sessionConnected: true,
    lastAdvertisedAtMs: null,
    nowMs: 1_000,
    sessionLeaseTtlMs: 120_000,
  });

  assert.deepEqual(state, { kind: "pending" });
  assert.equal(canQuoteJobs(state), false);
});

test("a live, fresh advertisement is available and reports its next refresh and expiry", () => {
  const state = deriveProviderAvailability({
    advertisingEnabled: true,
    sessionConnected: true,
    lastAdvertisedAtMs: 100_000,
    nowMs: 110_000,
    sessionLeaseTtlMs: 120_000,
  });

  assert.deepEqual(state, {
    kind: "available",
    refreshDueAtMs: 145_000,
    expiresAtMs: 220_000,
  });
  assert.equal(canQuoteJobs(state), true);
});

test("a dropped session reads as stale immediately, mid-lease — offline costs reachability only", () => {
  const state = deriveProviderAvailability({
    advertisingEnabled: true,
    sessionConnected: false,
    lastAdvertisedAtMs: 100_000,
    nowMs: 100_500,
    sessionLeaseTtlMs: 120_000,
  });

  assert.deepEqual(state, { kind: "stale" });
  assert.equal(canQuoteJobs(state), false);
});

test("a missed refresh past the lease reads as stale — never advertise longer than routable", () => {
  const state = deriveProviderAvailability({
    advertisingEnabled: true,
    sessionConnected: true,
    lastAdvertisedAtMs: 0,
    nowMs: 120_000,
    sessionLeaseTtlMs: 120_000,
  });

  assert.deepEqual(state, { kind: "stale" });
  assert.equal(canQuoteJobs(state), false);
});

test("a lease boundary reads as fresh right up to, but not including, expiry", () => {
  const state = deriveProviderAvailability({
    advertisingEnabled: true,
    sessionConnected: true,
    lastAdvertisedAtMs: 0,
    nowMs: 119_999,
    sessionLeaseTtlMs: 120_000,
  });

  assert.equal(state.kind, "available");
});

test("caption text is honest and non-null only where there is something to say", () => {
  assert.equal(providerAvailabilityCaption({ kind: "unadvertised" }), null);
  assert.match(providerAvailabilityCaption({ kind: "pending" }), /Publishing/);
  assert.match(
    providerAvailabilityCaption({
      kind: "available",
      refreshDueAtMs: 0,
      expiresAtMs: 0,
    }),
    /available/i,
  );
  assert.match(
    providerAvailabilityCaption({ kind: "stale" }),
    /not currently reachable/i,
  );
});
