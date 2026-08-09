import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SELL_PRICE_MICRO_USDC,
} from "./meshComputeSellPricing";

/**
 * Persists the seller's posted price + output-token ceiling (buzz#165).
 * Single record, not per-agent-pubkey: epic decision 4 is one node, one
 * whole model (and one advertisement) at a time, so there is exactly one
 * local seller configuration to persist.
 *
 * Follows `agentAutoRefillStore.ts`'s shape: injectable storage for tests,
 * a bumped `version` + subscriber set so `useSyncExternalStore` consumers
 * (and, once buzz#91 exists, a kind:31990 republish hook) invalidate on
 * every revision — the "without restarting the node" half of AC2.
 */

const STORAGE_KEY = "buzz-mesh-compute-sell-pricing.v1";

export type MeshComputeSellPricing = {
  priceMicroUsdcPer1kTokens: bigint;
  maxOutputTokens: number;
};

export type MeshComputeSellPricingStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type StoredRecord = {
  priceMicroUsdcPer1kTokens: string;
  maxOutputTokens: number;
};

function memoryStorage(): MeshComputeSellPricingStorage {
  const values = new Map<string, string>();
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

function defaultStorage(): MeshComputeSellPricingStorage {
  if (typeof window === "undefined" || !window.localStorage) {
    return memoryStorage();
  }
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => {
      setLocalStorageItemWithRecovery(key, value);
    },
    removeItem: (key) => window.localStorage.removeItem(key),
  };
}

let storage: MeshComputeSellPricingStorage = defaultStorage();
const listeners = new Set<() => void>();
let version = 0;

// `getMeshComputeSellPricing` parses a fresh object from storage on every
// call, so it cannot be used directly as a `useSyncExternalStore` snapshot —
// the identity change on every render trips React's "getSnapshot must be
// cached" loop guard (error #185, per `providerCapabilitySettings.ts`).
// This cache gives reads a referentially stable snapshot between writes.
let snapshotCache: MeshComputeSellPricing | null = null;

/** Swap the backing store. For tests. */
export function setMeshComputeSellPricingStorage(
  next: MeshComputeSellPricingStorage | null,
): void {
  storage = next ?? defaultStorage();
  notify();
}

function notify(): void {
  version++;
  snapshotCache = null;
  for (const listener of listeners) listener();
}

/** Bumped on every write — lets `useSyncExternalStore` consumers invalidate on any change. */
export function getMeshComputeSellPricingVersion(): number {
  return version;
}

/** Observe every revision — the settings card and any future republish hook read from this. */
export function subscribeToMeshComputeSellPricing(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const DEFAULT_PRICING: MeshComputeSellPricing = {
  priceMicroUsdcPer1kTokens: DEFAULT_SELL_PRICE_MICRO_USDC,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
};

function readRecord(): MeshComputeSellPricing {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn(
      "[mesh-compute-sell-pricing] could not read stored state",
      error,
    );
    return { ...DEFAULT_PRICING };
  }
  if (!raw) return { ...DEFAULT_PRICING };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      "[mesh-compute-sell-pricing] stored state was not readable JSON",
      error,
    );
    return { ...DEFAULT_PRICING };
  }
  if (!isJsonObject(parsed)) return { ...DEFAULT_PRICING };

  const record = parsed as Partial<StoredRecord>;
  let priceMicroUsdcPer1kTokens = DEFAULT_SELL_PRICE_MICRO_USDC;
  if (typeof record.priceMicroUsdcPer1kTokens === "string") {
    try {
      const parsedPrice = BigInt(record.priceMicroUsdcPer1kTokens);
      if (parsedPrice > 0n) priceMicroUsdcPer1kTokens = parsedPrice;
    } catch {
      // Fall through to the default.
    }
  }

  const maxOutputTokens =
    typeof record.maxOutputTokens === "number" &&
    Number.isInteger(record.maxOutputTokens) &&
    record.maxOutputTokens > 0
      ? record.maxOutputTokens
      : DEFAULT_MAX_OUTPUT_TOKENS;

  return { priceMicroUsdcPer1kTokens, maxOutputTokens };
}

/** The seller's current posted price and output-token ceiling. Defaults when nothing has been saved. */
export function getMeshComputeSellPricing(): MeshComputeSellPricing {
  return readRecord();
}

/**
 * The cached, referentially-stable read behind `useMeshComputeSellPricing`
 * (see `snapshotCache` above). Exported for direct assertions in tests;
 * production code should prefer the hook.
 */
export function getMeshComputeSellPricingSnapshot(): MeshComputeSellPricing {
  if (snapshotCache) return snapshotCache;
  snapshotCache = readRecord();
  return snapshotCache;
}

/**
 * Revise the posted price and/or ceiling. A non-positive value in either
 * field is rejected outright rather than silently stored — a price of zero
 * or an unbounded ceiling is not a valid advertisement.
 */
export function setMeshComputeSellPricing(next: MeshComputeSellPricing): void {
  if (next.priceMicroUsdcPer1kTokens <= 0n) return;
  if (!Number.isInteger(next.maxOutputTokens) || next.maxOutputTokens <= 0) {
    return;
  }

  const record: StoredRecord = {
    priceMicroUsdcPer1kTokens: next.priceMicroUsdcPer1kTokens.toString(),
    maxOutputTokens: next.maxOutputTokens,
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    console.warn("[mesh-compute-sell-pricing] could not persist state", error);
  }
  notify();
}
