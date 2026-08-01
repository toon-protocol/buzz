import {
  type ChannelKey,
  channelKeyId,
  formatChannelKey,
  parseChannelKey,
} from "@/shared/api/channelEncryption";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

/**
 * Where this client's channel keys live between launches.
 *
 * Key *delivery* is out of scope for now — a human copies the hex out of one
 * client's channel settings and pastes it into another's, or an operator sets
 * `BUZZ_CHANNEL_KEYS` before launch. What is in scope is that the key survives
 * a restart: history on TOON is ciphertext held by an open relay, so a client
 * that forgets its key does not lose "new messages", it loses the channel.
 * Persistence is therefore a correctness requirement, not a convenience.
 *
 * Keys are held as bytes in a module-level cache and as hex in the backing
 * store. The cache is not an optimisation — it is what lets a caller compare
 * key identity cheaply on every inbound event without re-parsing hex.
 *
 * The backing store is `localStorage`, the same place the rest of the app's
 * per-channel preferences live. That is a deliberate v1 limitation and the
 * honest statement of the threat model: this protects the channel from the
 * relay and from non-members, not from someone with the user's disk. Moving
 * to the OS keychain is a change of backend behind {@link setChannelKeyStorage}
 * and nothing else.
 */

/** Versioned so a future re-encoding can migrate rather than mis-read. */
const STORAGE_KEY = "buzz-channel-keys.v1";

/**
 * The slice of `Storage` this module needs.
 *
 * Narrow on purpose: a keychain-backed replacement has to implement three
 * methods, not the whole DOM interface.
 */
export type ChannelKeyStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): ChannelKeyStorage {
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

/**
 * `localStorage` in the app, an in-memory map anywhere else.
 *
 * Unit tests and any non-DOM host get a working store rather than a throw:
 * a missing `window` is a reason to keep keys for this process only, not a
 * reason for the crypto path to be untestable.
 */
function defaultStorage(): ChannelKeyStorage {
  if (typeof window === "undefined" || !window.localStorage) {
    return memoryStorage();
  }
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => {
      // Shares the app's quota-recovery path: a full localStorage must evict
      // caches, never silently drop the one value that is not re-fetchable.
      setLocalStorageItemWithRecovery(key, value);
    },
    removeItem: (key) => {
      window.localStorage.removeItem(key);
    },
  };
}

let storage: ChannelKeyStorage = defaultStorage();
let cache: Map<string, ChannelKey> | null = null;
const listeners = new Set<() => void>();

/** Swap the backing store. For tests and for a future keychain backend. */
export function setChannelKeyStorage(next: ChannelKeyStorage | null): void {
  storage = next ?? defaultStorage();
  cache = null;
}

function readStore(): Map<string, ChannelKey> {
  const loaded = new Map<string, ChannelKey>();
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn("[channel-keys] could not read stored keys", error);
    return loaded;
  }
  if (!raw) return loaded;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A corrupted record is dropped rather than repaired: the only thing worse
    // than losing a key is decrypting with something that is not it.
    console.warn("[channel-keys] stored keys were not readable JSON", error);
    return loaded;
  }
  if (typeof parsed !== "object" || parsed === null) return loaded;

  for (const [channelId, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value !== "string") continue;
    const key = parseChannelKey(value);
    if (key) loaded.set(channelId, key);
  }
  return loaded;
}

function ensureCache(): Map<string, ChannelKey> {
  cache ??= readStore();
  return cache;
}

function persist(keys: Map<string, ChannelKey>): void {
  const record: Record<string, string> = {};
  for (const [channelId, key] of keys) {
    record[channelId] = formatChannelKey(key);
  }
  try {
    if (Object.keys(record).length === 0) {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, JSON.stringify(record));
    }
  } catch (error) {
    console.warn("[channel-keys] could not persist keys", error);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Re-read the persisted keys, discarding the in-memory cache.
 *
 * What a restart does, without one — the app's own proof that history written
 * before the last launch still opens.
 */
export function reloadChannelKeys(): void {
  cache = null;
  ensureCache();
  notify();
}

/** The key for `channelId`, or null when this client is not a member. */
export function getChannelKey(channelId: string): ChannelKey | null {
  return ensureCache().get(channelId) ?? null;
}

/** Whether this client can read `channelId`. */
export function hasChannelKey(channelId: string): boolean {
  return ensureCache().has(channelId);
}

/** Store (or, with null, forget) the key for `channelId`. */
export function setChannelKey(channelId: string, key: ChannelKey | null): void {
  const keys = ensureCache();
  if (key === null) {
    if (!keys.delete(channelId)) return;
  } else {
    keys.set(channelId, key);
  }
  persist(keys);
  notify();
}

/** The channels this client holds a key for. */
export function encryptedChannelIds(): string[] {
  return [...ensureCache().keys()];
}

/**
 * The full key map as hex: `{ channelId: hexKey }`.
 *
 * What `channelKeySync.ts` pushes to Rust's `sync_channel_keys` command so
 * Rust-built events (threaded replies, media messages, custom emoji, the
 * huddle STT pipeline — buzz#33) can seal against the same keys this store
 * holds. Same shape `persist` writes to `localStorage`, produced fresh from
 * the cache rather than reread from disk so it reflects whatever the caller
 * just changed.
 */
export function channelKeyRecord(): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [channelId, key] of ensureCache()) {
    record[channelId] = formatChannelKey(key);
  }
  return record;
}

/** Observe key changes — the settings UI re-renders from this. */
export function subscribeToChannelKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One `channelId=hexkey` pair from `BUZZ_CHANNEL_KEYS`. */
export type ChannelKeyEnvEntry = { channelId: string; key: ChannelKey };

/**
 * Parse the `BUZZ_CHANNEL_KEYS` env value.
 *
 * Shape is `channelId=hexkey`, separated by commas or newlines. It exists so a
 * two-client demo, a Playwright run, or a devnet box can be brought up with
 * both ends already keyed — a human pasting hex into two GUIs is the
 * out-of-band delivery this phase ships, but it is not something a test can do.
 *
 * Pure, and returns its complaints rather than logging them, so the precedence
 * and validation rules are testable without an environment.
 */
export function parseChannelKeyEnv(value: string | null | undefined): {
  entries: ChannelKeyEnvEntry[];
  warnings: string[];
} {
  const entries: ChannelKeyEnvEntry[] = [];
  const warnings: string[] = [];
  const trimmed = value?.trim();
  if (!trimmed) return { entries, warnings };

  for (const rawPair of trimmed.split(/[,\n]/)) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      warnings.push(`Ignoring "${pair}" — expected channelId=hexkey.`);
      continue;
    }
    const channelId = pair.slice(0, separator).trim();
    const key = parseChannelKey(pair.slice(separator + 1));
    if (!channelId) {
      warnings.push(`Ignoring "${pair}" — the channel id is empty.`);
      continue;
    }
    if (!key) {
      // Never echo the value: a mistyped key is still a secret.
      warnings.push(
        `Ignoring the key for channel "${channelId}" — not 32 bytes of hex.`,
      );
      continue;
    }
    entries.push({ channelId, key });
  }

  return { entries, warnings };
}

/**
 * Load `BUZZ_CHANNEL_KEYS` into the store, overwriting what is persisted.
 *
 * The environment wins on purpose. It is set by whoever launched the process,
 * which makes it the more recent instruction, and a harness that cannot
 * override a stale saved key cannot be relied on to test anything.
 */
export function seedChannelKeysFromEnv(
  env: Record<string, string | null | undefined>,
): string[] {
  const { entries, warnings } = parseChannelKeyEnv(env.BUZZ_CHANNEL_KEYS);
  if (entries.length === 0) return warnings;

  const keys = ensureCache();
  for (const entry of entries) {
    keys.set(entry.channelId, entry.key);
    console.info(
      `[channel-keys] ${entry.channelId} keyed from the environment (key ${channelKeyId(entry.key)})`,
    );
  }
  persist(keys);
  notify();
  return warnings;
}
