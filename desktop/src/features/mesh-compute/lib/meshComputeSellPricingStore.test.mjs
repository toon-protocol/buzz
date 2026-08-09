import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SELL_PRICE_MICRO_USDC,
} from "./meshComputeSellPricing.ts";
import {
  getMeshComputeSellPricing,
  getMeshComputeSellPricingSnapshot,
  getMeshComputeSellPricingVersion,
  setMeshComputeSellPricing,
  setMeshComputeSellPricingStorage,
  subscribeToMeshComputeSellPricing,
} from "./meshComputeSellPricingStore.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

test.beforeEach(() => {
  setMeshComputeSellPricingStorage(memoryStorage());
});

test("reads defaults when nothing has been saved", () => {
  const pricing = getMeshComputeSellPricing();
  assert.equal(
    pricing.priceMicroUsdcPer1kTokens,
    DEFAULT_SELL_PRICE_MICRO_USDC,
  );
  assert.equal(pricing.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
});

test("a revision round-trips through storage", () => {
  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 9_500n,
    maxOutputTokens: 4096,
  });
  const pricing = getMeshComputeSellPricing();
  assert.equal(pricing.priceMicroUsdcPer1kTokens, 9_500n);
  assert.equal(pricing.maxOutputTokens, 4096);
});

test("a revision survives a fresh read from the same backing storage", () => {
  const storage = memoryStorage();
  setMeshComputeSellPricingStorage(storage);
  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 1_234n,
    maxOutputTokens: 512,
  });

  // Simulate a new module load reading the same persisted storage.
  setMeshComputeSellPricingStorage(storage);
  const pricing = getMeshComputeSellPricing();
  assert.equal(pricing.priceMicroUsdcPer1kTokens, 1_234n);
  assert.equal(pricing.maxOutputTokens, 512);
});

test("a non-positive price or ceiling is rejected, not silently stored", () => {
  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 0n,
    maxOutputTokens: 2048,
  });
  assert.equal(
    getMeshComputeSellPricing().priceMicroUsdcPer1kTokens,
    DEFAULT_SELL_PRICE_MICRO_USDC,
  );

  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 2_000n,
    maxOutputTokens: 0,
  });
  assert.equal(
    getMeshComputeSellPricing().maxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
  );
});

test("malformed stored JSON falls back to defaults instead of throwing", () => {
  const storage = memoryStorage();
  storage.setItem("buzz-mesh-compute-sell-pricing.v1", "not json");
  setMeshComputeSellPricingStorage(storage);
  const pricing = getMeshComputeSellPricing();
  assert.equal(
    pricing.priceMicroUsdcPer1kTokens,
    DEFAULT_SELL_PRICE_MICRO_USDC,
  );
  assert.equal(pricing.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
});

// ── AC2: "revise it without restarting the node" ────────────────────────
// A version counter + subscription is the mechanism a future kind:31990
// publisher (buzz#91) hooks into to re-publish on every revision, without
// this module needing to know anything about Nostr or the relay.

test("every revision bumps the version counter", () => {
  const before = getMeshComputeSellPricingVersion();
  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 3_000n,
    maxOutputTokens: 1024,
  });
  assert.ok(getMeshComputeSellPricingVersion() > before);
});

// ── snapshot caching (React error #185 guard) ───────────────────────────

test("the snapshot is referentially stable between reads with no revision", () => {
  const first = getMeshComputeSellPricingSnapshot();
  const second = getMeshComputeSellPricingSnapshot();
  assert.equal(first, second);
});

test("the snapshot changes identity after a revision", () => {
  const before = getMeshComputeSellPricingSnapshot();
  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 5_000n,
    maxOutputTokens: 1024,
  });
  const after = getMeshComputeSellPricingSnapshot();
  assert.notEqual(before, after);
  assert.equal(after.priceMicroUsdcPer1kTokens, 5_000n);
});

test("subscribers are notified on revision", () => {
  let notifications = 0;
  const unsubscribe = subscribeToMeshComputeSellPricing(() => {
    notifications++;
  });
  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 3_000n,
    maxOutputTokens: 1024,
  });
  unsubscribe();
  setMeshComputeSellPricing({
    priceMicroUsdcPer1kTokens: 4_000n,
    maxOutputTokens: 1024,
  });
  assert.equal(notifications, 1);
});
