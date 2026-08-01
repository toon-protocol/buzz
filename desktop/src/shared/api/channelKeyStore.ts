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
 * History on TOON is ciphertext held by an open relay, so a client that
 * forgets a key does not lose "new messages", it loses the channel.
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
 *
 * ## A ring per channel, not a key (buzz#18)
 *
 * Rotation on member removal mints a new key and leaves the old one valid for
 * everything already written under it (ADR 0001: "removed members retain
 * history they already had"). So a channel holds a *ring* of keys rather than
 * one, and the ring is ordered: **index 0 is the sending key**, the rest are
 * held for reading only.
 *
 * That ordering is the whole state model. There is no separate "current key
 * id" field to fall out of sync with the ring's contents — a channel with any
 * key has exactly one sending key, and it is the first one. Two operations
 * move it: {@link adoptChannelKey} takes a newly delivered key in (behind the
 * sending key by default, because a key is only *this channel's* key once the
 * validated admin list says so — see `channelKeyEpoch.ts`), and
 * {@link promoteChannelKey} moves a held key to the front when it does.
 *
 * ## v1 → v2
 *
 * v1 stored `{ channelId: hexKey }`. v2 stores
 * `{ version: 2, channels: { channelId: [hexKey, ...] } }`. A v1 record is
 * migrated on first read — its single key becomes a one-key ring — and then
 * **deleted**. Deleting it loses the rollback path to a pre-#18 build, and
 * that is the intended trade: leaving it behind would mean "Forget key" and a
 * rotation both left the superseded bytes sitting in a record nothing ever
 * rewrites, which is a worse promise to break than downgrade convenience.
 */

/** Versioned so a re-encoding migrates rather than mis-reads. */
const STORAGE_KEY = "buzz-channel-keys.v2";

/** The pre-#18 record: one key per channel. Read once, migrated, removed. */
const STORAGE_KEY_V1 = "buzz-channel-keys.v1";

/**
 * How many keys one channel may keep.
 *
 * A bound rather than unlimited history because the ring lives in
 * `localStorage`, which the whole app shares and which
 * `setLocalStorageItemWithRecovery` has to be able to fit. Sixteen epochs of a
 * channel is a lot of removals; past that the oldest key is dropped and the
 * messages sealed under it stop opening, which is the same outcome as never
 * having been sent the key and renders the same way.
 */
const MAX_KEYS_PER_CHANNEL = 16;

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

/** One channel's keys, sending key first. Never empty — the entry is removed. */
type ChannelKeyRing = ChannelKey[];

let storage: ChannelKeyStorage = defaultStorage();
let cache: Map<string, ChannelKeyRing> | null = null;
const listeners = new Set<() => void>();

/** Swap the backing store. For tests and for a future keychain backend. */
export function setChannelKeyStorage(next: ChannelKeyStorage | null): void {
  storage = next ?? defaultStorage();
  cache = null;
}

function readRaw(key: string): unknown {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    console.warn("[channel-keys] could not read stored keys", error);
    return null;
  }
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    // A corrupted record is dropped rather than repaired: the only thing worse
    // than losing a key is decrypting with something that is not it.
    console.warn("[channel-keys] stored keys were not readable JSON", error);
    return null;
  }
}

function sameKey(left: ChannelKey, right: ChannelKey): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Parse a ring, dropping entries that are not 32 bytes of hex. */
function parseRing(value: unknown): ChannelKeyRing {
  if (!Array.isArray(value)) return [];
  const ring: ChannelKeyRing = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const key = parseChannelKey(entry);
    if (key && !ring.some((held) => sameKey(held, key))) ring.push(key);
  }
  return ring.slice(0, MAX_KEYS_PER_CHANNEL);
}

/** The pre-#18 record, as one-key rings. Null when there is nothing to migrate. */
function readV1(): Map<string, ChannelKeyRing> | null {
  const parsed = readRaw(STORAGE_KEY_V1);
  if (typeof parsed !== "object" || parsed === null) return null;

  const loaded = new Map<string, ChannelKeyRing>();
  for (const [channelId, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value !== "string") continue;
    const key = parseChannelKey(value);
    if (key) loaded.set(channelId, [key]);
  }
  return loaded;
}

function readStore(): {
  rings: Map<string, ChannelKeyRing>;
  migrated: boolean;
} {
  const parsed = readRaw(STORAGE_KEY);
  if (typeof parsed === "object" && parsed !== null) {
    const channels = (parsed as { channels?: unknown }).channels;
    const rings = new Map<string, ChannelKeyRing>();
    if (typeof channels === "object" && channels !== null) {
      for (const [channelId, value] of Object.entries(
        channels as Record<string, unknown>,
      )) {
        const ring = parseRing(value);
        if (ring.length > 0) rings.set(channelId, ring);
      }
    }
    return { rings, migrated: false };
  }

  const legacy = readV1();
  if (legacy === null) return { rings: new Map(), migrated: false };
  return { rings: legacy, migrated: true };
}

function ensureCache(): Map<string, ChannelKeyRing> {
  if (cache === null) {
    const { rings, migrated } = readStore();
    cache = rings;
    // Rewrite in the v2 shape immediately, so the migration is a one-off
    // rather than something every launch redoes, and drop the v1 record with
    // it — see the module doc on why the rollback path is not kept.
    if (migrated) {
      persist(cache);
      try {
        storage.removeItem(STORAGE_KEY_V1);
      } catch (error) {
        console.warn("[channel-keys] could not clear the v1 key store", error);
      }
    }
  }
  return cache;
}

function persist(rings: Map<string, ChannelKeyRing>): void {
  const channels: Record<string, string[]> = {};
  for (const [channelId, ring] of rings) {
    channels[channelId] = ring.map(formatChannelKey);
  }
  try {
    if (Object.keys(channels).length === 0) {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, channels }));
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

/**
 * The key `channelId` *sends* with, or null when this client is not a member.
 *
 * The front of the ring. A reader wanting the key a specific message was
 * sealed under wants {@link findChannelKey} instead — after a rotation the two
 * differ for exactly the history the rotation left behind.
 */
export function getChannelKey(channelId: string): ChannelKey | null {
  return ensureCache().get(channelId)?.[0] ?? null;
}

/** Every key held for `channelId`, sending key first. */
export function getChannelKeys(channelId: string): readonly ChannelKey[] {
  return ensureCache().get(channelId) ?? [];
}

/**
 * The key named by `keyId`, or null when this client does not hold it.
 *
 * What the `["encrypted", "nip44-v2", <keyId>]` marker on every sealed message
 * resolves to. Null is the ordinary answer for a message from an epoch this
 * client was not in — including every post-rotation message for a removed
 * member, which is the point of rotating.
 */
export function findChannelKey(
  channelId: string,
  keyId: string,
): ChannelKey | null {
  for (const key of getChannelKeys(channelId)) {
    if (channelKeyId(key) === keyId) return key;
  }
  return null;
}

/** Whether this client can read `channelId` at all. */
export function hasChannelKey(channelId: string): boolean {
  return ensureCache().has(channelId);
}

/**
 * Take a key into `channelId`'s ring. Returns whether anything changed.
 *
 * Held for *reading* by default, not for sending: a key that has just arrived
 * in a gift wrap is not yet the epoch the channel agrees on, and a client that
 * started sealing with it the moment it landed would be posting messages the
 * other members cannot open (`channelKeyEpoch.ts` promotes it when the
 * validated admin list names it). The exception is a channel with no key at
 * all, where there is no ambiguity and nothing to be inconsistent with.
 *
 * A key already in the ring is left exactly where it is. That refusal is a
 * downgrade defence: re-adopting a superseded key would otherwise move it back
 * to the front and start sealing new messages under an epoch a removed member
 * still holds.
 */
export function adoptChannelKey(
  channelId: string,
  key: ChannelKey,
  options?: { makeCurrent?: boolean },
): boolean {
  const rings = ensureCache();
  const ring = rings.get(channelId);

  if (!ring) {
    rings.set(channelId, [key]);
    persist(rings);
    notify();
    return true;
  }

  if (ring.some((held) => sameKey(held, key))) return false;

  ring.splice(options?.makeCurrent ? 0 : 1, 0, key);
  if (ring.length > MAX_KEYS_PER_CHANNEL) ring.length = MAX_KEYS_PER_CHANNEL;
  persist(rings);
  notify();
  return true;
}

/**
 * Make a held key the one `channelId` sends with. Returns whether it moved.
 *
 * False for a key this client does not hold — the caller has seen an admin
 * list naming an epoch whose gift wrap has not arrived yet, which is ordinary
 * and self-correcting: the wrap lands, and adopting it runs this again.
 */
export function promoteChannelKey(channelId: string, keyId: string): boolean {
  const rings = ensureCache();
  const ring = rings.get(channelId);
  if (!ring) return false;

  const index = ring.findIndex((key) => channelKeyId(key) === keyId);
  if (index <= 0) return false;

  const [key] = ring.splice(index, 1);
  ring.unshift(key);
  persist(rings);
  notify();
  return true;
}

/**
 * Adopt `key` as `channelId`'s sending key, or with null forget the channel
 * entirely — every epoch of it, not just the current one.
 *
 * The blunt verb, for the two places a human is the authority: pasting a key
 * into channel settings, and "Forget key". Automatic delivery goes through
 * {@link adoptChannelKey} instead, which does not presume the arriving key is
 * the one to send with.
 */
export function setChannelKey(channelId: string, key: ChannelKey | null): void {
  if (key === null) {
    const rings = ensureCache();
    if (!rings.delete(channelId)) return;
    persist(rings);
    notify();
    return;
  }

  const keyId = channelKeyId(key);
  if (adoptChannelKey(channelId, key, { makeCurrent: true })) return;
  promoteChannelKey(channelId, keyId);
}

/** The channels this client holds a key for. */
export function encryptedChannelIds(): string[] {
  return [...ensureCache().keys()];
}

/**
 * The *sending* key of every keyed channel, as hex: `{ channelId: hexKey }`.
 *
 * What `channelKeySync.ts` pushes to Rust's `sync_channel_keys` command so
 * Rust-built events (threaded replies, media messages, custom emoji, the
 * huddle STT pipeline — buzz#33) can seal against the same key
 * `sendStreamMessage` would. Produced fresh from the cache rather than reread
 * from disk so it reflects whatever the caller just changed.
 *
 * One key per channel, deliberately: Rust only *seals*, and sealing has
 * exactly one right answer. The older epochs a rotation leaves behind matter
 * only for opening history, which is the frontend's job
 * (`channelMessageCrypto.ts`). Rotation therefore reaches Rust as a plain
 * re-sync of a changed value — no new command, no shape change — and because
 * `sync_channel_keys` replaces rather than merges, the superseded key is gone
 * from the Rust side the moment the front of the ring moves.
 */
export function channelKeyRecord(): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [channelId, ring] of ensureCache()) {
    const current = ring[0];
    if (current) record[channelId] = formatChannelKey(current);
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
 * Load `BUZZ_CHANNEL_KEYS` into the store, overriding what each named channel
 * sends with.
 *
 * The environment wins on purpose. It is set by whoever launched the process,
 * which makes it the more recent instruction, and a harness that cannot
 * override a stale saved key cannot be relied on to test anything.
 *
 * It overrides the *sending* key and keeps the rest of the ring: an operator
 * pointing a client at one epoch of a channel is not asking it to forget the
 * history it can already read.
 */
export function seedChannelKeysFromEnv(
  env: Record<string, string | null | undefined>,
): string[] {
  const { entries, warnings } = parseChannelKeyEnv(env.BUZZ_CHANNEL_KEYS);
  if (entries.length === 0) return warnings;

  for (const entry of entries) {
    setChannelKey(entry.channelId, entry.key);
    console.info(
      `[channel-keys] ${entry.channelId} keyed from the environment (key ${channelKeyId(entry.key)})`,
    );
  }
  return warnings;
}
