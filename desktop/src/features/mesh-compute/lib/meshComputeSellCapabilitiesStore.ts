import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

/**
 * Persists the seller's advertised model and VRAM ceiling (buzz#173).
 * Single record, not per-agent-pubkey: epic decision 4 is one node, one
 * whole model (and one advertisement) at a time, same as
 * `meshComputeSellPricingStore.ts` (buzz#165).
 *
 * Follows that same store's shape: injectable storage for tests, plus a
 * subscriber set and a bumped `version` so every revision is observable —
 * by `useSyncExternalStore` consumers today and, once buzz#91 exists, by a
 * kind:31990 republish hook (AC4).
 *
 * Recording a VRAM ceiling here is a claim about capability, not an
 * enforcement mechanism (buzz#173 gotcha) — nothing in this module checks
 * the number against real hardware or rejects a job at it. The seller-side
 * enforcement that keeps an over-claim from silently accepting work the
 * machine cannot run is later ticket scope, the same way buzz#165 left
 * `max_tokens` enforcement to buzz#92.
 *
 * Deliberately NOT registered in `resetCommunityState()`: this machine's
 * sell-compute capabilities belong to the machine, not to whichever
 * community is open, so switching communities must not clear them.
 */

const STORAGE_KEY = "buzz-mesh-compute-sell-capabilities.v1";

export type MeshComputeSellCapabilities = {
  modelId: string | null;
  maxVramGb: number | null;
};

export type MeshComputeSellCapabilitiesStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): MeshComputeSellCapabilitiesStorage {
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

function defaultStorage(): MeshComputeSellCapabilitiesStorage {
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

let storage: MeshComputeSellCapabilitiesStorage = defaultStorage();
const listeners = new Set<() => void>();
let version = 0;

// Same "cached snapshot" requirement as meshComputeSellPricingStore.ts:
// getMeshComputeSellCapabilities parses a fresh object on every call, which
// trips React's "getSnapshot must be cached" loop guard (error #185) if used
// directly as a useSyncExternalStore snapshot.
let snapshotCache: MeshComputeSellCapabilities | null = null;

/** Swap the backing store. For tests. */
export function setMeshComputeSellCapabilitiesStorage(
  next: MeshComputeSellCapabilitiesStorage | null,
): void {
  storage = next ?? defaultStorage();
  notify();
}

function notify(): void {
  version++;
  snapshotCache = null;
  for (const listener of listeners) listener();
}

/** Bumped on every revision (and on a storage swap) — a scalar "has it changed?" read. */
export function getMeshComputeSellCapabilitiesVersion(): number {
  return version;
}

/** Observe every revision — the settings card and any future republish hook read from this. */
export function subscribeToMeshComputeSellCapabilities(
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

const UNSET_CAPABILITIES: MeshComputeSellCapabilities = {
  modelId: null,
  maxVramGb: null,
};

/**
 * The single definition of what counts as an advertised capability: a blank
 * model id and a non-positive/non-finite VRAM ceiling are both "unset". Used
 * on both sides of storage, so a hand-edited record is read under exactly the
 * rules a revision is written under.
 */
function normalizeCapabilities(
  modelId: unknown,
  maxVramGb: unknown,
): MeshComputeSellCapabilities {
  const trimmedModelId = typeof modelId === "string" ? modelId.trim() : "";
  const isPositiveNumber =
    typeof maxVramGb === "number" &&
    Number.isFinite(maxVramGb) &&
    maxVramGb > 0;
  return {
    modelId: trimmedModelId === "" ? null : trimmedModelId,
    maxVramGb: isPositiveNumber ? maxVramGb : null,
  };
}

function readRecord(): MeshComputeSellCapabilities {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn(
      "[mesh-compute-sell-capabilities] could not read stored state",
      error,
    );
    return { ...UNSET_CAPABILITIES };
  }
  if (!raw) return { ...UNSET_CAPABILITIES };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      "[mesh-compute-sell-capabilities] stored state was not readable JSON",
      error,
    );
    return { ...UNSET_CAPABILITIES };
  }
  if (!isJsonObject(parsed)) return { ...UNSET_CAPABILITIES };

  return normalizeCapabilities(parsed.modelId, parsed.maxVramGb);
}

/**
 * The seller's current advertised model and VRAM ceiling, read straight from
 * storage. Unset (`null`) fields when nothing has been saved. Returns a
 * fresh object every call — React consumers want the hook (and, under it,
 * `getMeshComputeSellCapabilitiesSnapshot`) instead.
 */
export function getMeshComputeSellCapabilities(): MeshComputeSellCapabilities {
  return readRecord();
}

/**
 * The cached, referentially-stable read behind `useMeshComputeSellCapabilities`
 * (see `snapshotCache` above) — the `getSnapshot` a `useSyncExternalStore`
 * consumer needs. Components should reach for the hook, not this.
 */
export function getMeshComputeSellCapabilitiesSnapshot(): MeshComputeSellCapabilities {
  if (snapshotCache) return snapshotCache;
  snapshotCache = readRecord();
  return snapshotCache;
}

/**
 * Revise the advertised model and/or VRAM ceiling. A blank model id is
 * stored as unset rather than an empty string; a non-positive VRAM ceiling
 * is rejected outright rather than silently stored — neither is a valid
 * advertised capability.
 */
export function setMeshComputeSellCapabilities(
  next: MeshComputeSellCapabilities,
): void {
  const record = normalizeCapabilities(next.modelId, next.maxVramGb);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    console.warn(
      "[mesh-compute-sell-capabilities] could not persist state",
      error,
    );
  }
  notify();
}
