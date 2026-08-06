import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

/**
 * The opt-in + hard monthly ceiling for buzz#132's auto-refill (epic
 * toon-meta#261 decision 8). Two independent pieces of state per agent
 * pubkey, both persisted here:
 *
 * - **Config** — `{ enabled: false } | { enabled: true; ceilingBaseUnits }`,
 *   so "enabled with no ceiling" is unrepresentable (AC1).
 * - **Ledger** — `{ monthKey, spentBaseUnits }`, incremented only after a
 *   deposit confirms (never on intent — a failed deposit must not
 *   permanently eat ceiling). Deliberately kept even when the config is
 *   disabled: re-enabling mid-month must not reset spend, or toggling
 *   off/on would bypass the ceiling it exists to enforce.
 *
 * `monthKey` is the UTC `YYYY-MM` the spend was recorded in — UTC rather
 * than local so a travelling user can't collect a double allowance by
 * crossing a timezone boundary near midnight. Rollover is evaluated lazily
 * on read (AC4): a stale month's `spentBaseUnits` simply reads as zero, no
 * timer or background job required, and it survives the app being closed
 * across a month boundary.
 *
 * Persistence follows `agentProvisioningStore.ts`: localStorage keyed per
 * agent pubkey, `setLocalStorageItemWithRecovery`'s quota handling, and
 * injectable storage for tests.
 *
 * ⚠️ **Durability is per-machine, not a hard guarantee** (owner-approved for
 * v1): losing localStorage resets the ceiling to full — the ceiling is a
 * safety bound on top of the real, on-chain source of truth (deposits),
 * never a correctness bound. Surface this limitation wherever the ceiling is
 * configured. Not registered in `resetCommunityState()` — like
 * `agentProvisioningStore.ts`, these keys are pubkey-scoped, not
 * community/relay-scoped, so a community switch must not clear them.
 */

const STORAGE_PREFIX = "buzz-agent-refill.v1";

export type AutoRefillConfig =
  | { enabled: false }
  | { enabled: true; ceilingBaseUnits: bigint };

export type AgentAutoRefillStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type StoredRecord = {
  enabled: boolean;
  /** Present only while `enabled`. */
  ceilingBaseUnits: string | null;
  /** Null until the first confirmed refill. */
  monthKey: string | null;
  spentBaseUnits: string;
};

const EMPTY_RECORD: StoredRecord = {
  enabled: false,
  ceilingBaseUnits: null,
  monthKey: null,
  spentBaseUnits: "0",
};

function memoryStorage(): AgentAutoRefillStorage {
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

function defaultStorage(): AgentAutoRefillStorage {
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

let storage: AgentAutoRefillStorage = defaultStorage();
const listeners = new Set<() => void>();
let version = 0;

/** Swap the backing store. For tests. */
export function setAgentAutoRefillStorage(
  next: AgentAutoRefillStorage | null,
): void {
  storage = next ?? defaultStorage();
  notify();
}

function storageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}:${pubkey}`;
}

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Bumped on every write — lets `useSyncExternalStore` consumers invalidate on any change. */
export function getAgentAutoRefillVersion(): number {
  return version;
}

/** Observe any change — the Network spend block and ceiling-reached alert re-render from this. */
export function subscribeToAgentAutoRefillState(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isStoredRecord(value: unknown): value is Partial<StoredRecord> {
  return typeof value === "object" && value !== null;
}

function readRecord(pubkey: string): StoredRecord {
  let raw: string | null = null;
  try {
    raw = storage.getItem(storageKey(pubkey));
  } catch (error) {
    console.warn("[agent-auto-refill] could not read stored state", error);
    return { ...EMPTY_RECORD };
  }
  if (!raw) return { ...EMPTY_RECORD };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      "[agent-auto-refill] stored state was not readable JSON",
      error,
    );
    return { ...EMPTY_RECORD };
  }
  if (!isStoredRecord(parsed)) return { ...EMPTY_RECORD };

  return {
    enabled: parsed.enabled === true,
    ceilingBaseUnits:
      typeof parsed.ceilingBaseUnits === "string"
        ? parsed.ceilingBaseUnits
        : null,
    monthKey: typeof parsed.monthKey === "string" ? parsed.monthKey : null,
    spentBaseUnits:
      typeof parsed.spentBaseUnits === "string" ? parsed.spentBaseUnits : "0",
  };
}

function writeRecord(pubkey: string, record: StoredRecord): void {
  try {
    storage.setItem(storageKey(pubkey), JSON.stringify(record));
  } catch (error) {
    console.warn("[agent-auto-refill] could not persist state", error);
  }
  notify();
}

/** The UTC `YYYY-MM` ledger month for `now`. */
export function currentUtcMonthKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** The opt-in + ceiling for `pubkey`. Off by default (AC1). */
export function getAutoRefillConfig(pubkey: string): AutoRefillConfig {
  const record = readRecord(pubkey);
  if (!record.enabled || record.ceilingBaseUnits === null) {
    return { enabled: false };
  }
  try {
    return { enabled: true, ceilingBaseUnits: BigInt(record.ceilingBaseUnits) };
  } catch {
    return { enabled: false };
  }
}

/**
 * Set `pubkey`'s opt-in + ceiling. Disabling never touches the ledger — spend
 * already recorded this month still counts if the operator re-enables before
 * the month rolls over.
 */
export function setAutoRefillConfig(
  pubkey: string,
  config: AutoRefillConfig,
): void {
  const record = readRecord(pubkey);
  writeRecord(pubkey, {
    ...record,
    enabled: config.enabled,
    ceilingBaseUnits: config.enabled
      ? config.ceilingBaseUnits.toString()
      : null,
  });
}

function parseBaseUnits(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Spend recorded against `pubkey`'s ceiling in `now`'s UTC month — zero once the month has rolled over. */
export function getMonthlyRefillSpendBaseUnits(
  pubkey: string,
  now: Date = new Date(),
): bigint {
  const record = readRecord(pubkey);
  if (record.monthKey !== currentUtcMonthKey(now)) return 0n;
  return parseBaseUnits(record.spentBaseUnits);
}

/**
 * Ceiling left to spend this month, or `null` when auto-refill isn't
 * enabled. Floored at zero — accounting drift must never show a negative
 * remaining ceiling as "still has room."
 */
export function getRemainingCeilingBaseUnits(
  pubkey: string,
  now: Date = new Date(),
): bigint | null {
  const config = getAutoRefillConfig(pubkey);
  if (!config.enabled) return null;
  const remaining =
    config.ceilingBaseUnits - getMonthlyRefillSpendBaseUnits(pubkey, now);
  return remaining > 0n ? remaining : 0n;
}

/**
 * Record a confirmed refill deposit against `pubkey`'s monthly ledger. Call
 * only after the deposit itself has resolved — never on intent, or a failed
 * deposit would permanently eat ceiling.
 */
export function recordConfirmedRefillBaseUnits(
  pubkey: string,
  amountBaseUnits: bigint,
  now: Date = new Date(),
): void {
  if (amountBaseUnits <= 0n) return;
  const monthKey = currentUtcMonthKey(now);
  const record = readRecord(pubkey);
  const spentSoFar =
    record.monthKey === monthKey ? parseBaseUnits(record.spentBaseUnits) : 0n;
  writeRecord(pubkey, {
    ...record,
    monthKey,
    spentBaseUnits: (spentSoFar + amountBaseUnits).toString(),
  });
}
