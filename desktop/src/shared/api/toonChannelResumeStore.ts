import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

/**
 * Where the TOON payment channel survives an app restart (buzz#28).
 *
 * The bug this fixes: `ToonPaidWriter` used to call `ToonClient`'s automatic
 * per-peer channel open on every `start()`, which has no memory of a channel
 * across restarts — `ChannelManager`'s peer→channelId map is in-memory only —
 * so every launch opened (and collateralized) a brand-new on-chain channel.
 *
 * `@toon-protocol/client` already has an answer for this: `channelStorePath`
 * + `JsonFileChannelStore` persist the nonce/cumulative-claim watermark to a
 * JSON file, and the toon-clientd daemon's `apex-channel-store.ts` (and rig's
 * `channel-map.ts` twin) additionally remember WHICH channel id a
 * (destination, chain) pair resolved to, since `ChannelManager` itself never
 * persists that half. Both of those are `node:fs`-backed, which is not
 * available here: `@toon-protocol/client` imports `fs` at module scope, and
 * building the desktop app's Tauri webview bundle (verified empirically —
 * `pnpm build`) shows Vite externalizing every Node builtin the client chain
 * touches (`fs`, `path`, `crypto`, …) to a stub that throws if actually
 * called. So this module keeps the exact same resume SHAPE — a channel id
 * plus the chain context and nonce watermark `ChannelManager.trackChannel`
 * needs to rehydrate a channel with zero on-chain writes — backed by
 * `localStorage` instead, the same way `toonOnboardingStore.ts` already
 * persists the wizard's own state in this app.
 *
 * Keyed by (destination, chain): a fresh writer resumes the channel it last
 * opened against the SAME peer on the SAME settlement chain, and nothing
 * else — a config change to either invalidates the old record rather than
 * resuming into a channel opened under different terms.
 */

export type PersistedChannelContext = {
  /** Settlement chain family, e.g. `'evm'`. */
  chainType: string;
  chainId: number;
  /** EVM TokenNetwork (payment-channel) contract address. */
  tokenNetworkAddress: string;
  /** Settlement token (USDC) contract address. */
  tokenAddress?: string;
};

export type PersistedChannel = {
  /** On-chain payment channel id. */
  channelId: string;
  /** Chain context `ChannelManager.trackChannel` needs to resume signing. */
  context: PersistedChannelContext;
  /** Next claim's nonce is `nonce + 1` — see `ChannelManager.signBalanceProof`. */
  nonce: number;
  /** Cumulative claimed amount, base units (string-encoded bigint). */
  cumulativeAmount: string;
};

export type ToonChannelStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): ToonChannelStorage {
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

function defaultStorage(): ToonChannelStorage {
  if (typeof window === "undefined" || !window.localStorage) {
    return memoryStorage();
  }
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => {
      setLocalStorageItemWithRecovery(key, value);
    },
    removeItem: (key) => {
      window.localStorage.removeItem(key);
    },
  };
}

let storage: ToonChannelStorage = defaultStorage();

/** Swap the backing store. For tests and for a future keychain backend. */
export function setToonChannelStorage(next: ToonChannelStorage | null): void {
  storage = next ?? defaultStorage();
}

const STORAGE_PREFIX = "buzz-toon-channel.v1";

function storageKey(destination: string, chain: string): string {
  return `${STORAGE_PREFIX}:${destination}|${chain}`;
}

function isPersistedChannelContext(
  value: unknown,
): value is PersistedChannelContext {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.chainType === "string" &&
    typeof c.chainId === "number" &&
    typeof c.tokenNetworkAddress === "string" &&
    (c.tokenAddress === undefined || typeof c.tokenAddress === "string")
  );
}

function isPersistedChannel(value: unknown): value is PersistedChannel {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.channelId === "string" &&
    typeof r.nonce === "number" &&
    typeof r.cumulativeAmount === "string" &&
    isPersistedChannelContext(r.context)
  );
}

/**
 * The persisted channel for (destination, chain), or null when there is
 * none — including when the record on disk is unreadable or malformed.
 * Never throws: a corrupt or stale record is exactly the "no resumable
 * channel" case, not a reason to block a fresh open.
 */
export function loadPersistedChannel(
  destination: string,
  chain: string,
): PersistedChannel | null {
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(destination, chain));
  } catch (error) {
    console.warn("[toon-channel] could not read the persisted channel", error);
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      "[toon-channel] persisted channel record was not readable JSON",
      error,
    );
    return null;
  }
  if (!isPersistedChannel(parsed)) {
    console.warn(
      "[toon-channel] persisted channel record is missing required fields",
    );
    return null;
  }
  return parsed;
}

/**
 * Record the channel to resume next launch. Called at open time and again
 * after every claim (nonce/cumulativeAmount change) — synchronously, before
 * the claim goes out over the network, so a crash mid-write never leaves a
 * STALE (behind) watermark on disk that could reuse a nonce the connector
 * already accepted. A crash after this write but before the network round
 * trip only wastes an unused nonce, which is safe.
 */
export function savePersistedChannel(
  destination: string,
  chain: string,
  record: PersistedChannel,
): void {
  try {
    storage.setItem(storageKey(destination, chain), JSON.stringify(record));
  } catch (error) {
    console.warn("[toon-channel] could not persist the channel", error);
  }
}

/** Forget the resumable channel for (destination, chain) — e.g. after a close. */
export function clearPersistedChannel(
  destination: string,
  chain: string,
): void {
  try {
    storage.removeItem(storageKey(destination, chain));
  } catch (error) {
    console.warn("[toon-channel] could not clear the persisted channel", error);
  }
}

/** Whether a resumable channel is on record for (destination, chain). */
export function hasPersistedChannel(
  destination: string,
  chain: string,
): boolean {
  return loadPersistedChannel(destination, chain) !== null;
}
