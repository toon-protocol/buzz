import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  formatChannelKey,
  generateChannelKey,
  parseChannelKey,
} from "./channelEncryption.ts";
import {
  encryptedChannelIds,
  getChannelKey,
  hasChannelKey,
  parseChannelKeyEnv,
  reloadChannelKeys,
  seedChannelKeysFromEnv,
  setChannelKey,
  setChannelKeyStorage,
  subscribeToChannelKeys,
} from "./channelKeyStore.ts";

const KEY_HEX = "b".repeat(64);
const OTHER_KEY_HEX = "c".repeat(64);

/** A disk that survives a "restart" — the store's cache does not. */
function fakeDisk(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

let disk;

beforeEach(() => {
  disk = fakeDisk();
  setChannelKeyStorage(disk);
});

test("a key set for one channel is not a key for another", () => {
  setChannelKey("engineering", parseChannelKey(KEY_HEX));

  assert.ok(hasChannelKey("engineering"));
  assert.equal(hasChannelKey("random"), false);
  assert.equal(getChannelKey("random"), null);
  assert.deepEqual(encryptedChannelIds(), ["engineering"]);
});

test("a stored key survives a restart", () => {
  // The whole point of persisting: on TOON the history is ciphertext held by
  // an open relay, so a client that forgets its key loses the channel, not
  // just the tail.
  setChannelKey("engineering", parseChannelKey(KEY_HEX));

  // Same disk, empty cache — what relaunching the app does.
  setChannelKeyStorage(disk);

  assert.equal(formatChannelKey(getChannelKey("engineering")), KEY_HEX);
});

test("forgetting a key clears it from disk too", () => {
  setChannelKey("engineering", parseChannelKey(KEY_HEX));
  setChannelKey("engineering", null);

  setChannelKeyStorage(disk);
  assert.equal(getChannelKey("engineering"), null);
  assert.deepEqual(encryptedChannelIds(), []);
});

test("subscribers hear about every change", () => {
  let notifications = 0;
  const unsubscribe = subscribeToChannelKeys(() => {
    notifications += 1;
  });

  setChannelKey("engineering", parseChannelKey(KEY_HEX));
  setChannelKey("engineering", null);
  reloadChannelKeys();
  unsubscribe();
  setChannelKey("engineering", parseChannelKey(KEY_HEX));

  assert.equal(notifications, 3);
});

test("forgetting a key that was never held notifies nobody", () => {
  let notifications = 0;
  subscribeToChannelKeys(() => {
    notifications += 1;
  });

  setChannelKey("never-keyed", null);

  assert.equal(notifications, 0);
});

test("a corrupted store is dropped, not guessed at", () => {
  // Decrypting with something that is not the key is worse than having none.
  setChannelKeyStorage(fakeDisk({ "buzz-channel-keys.v1": "{not json" }));
  assert.deepEqual(encryptedChannelIds(), []);

  setChannelKeyStorage(
    fakeDisk({
      "buzz-channel-keys.v1": JSON.stringify({
        good: KEY_HEX,
        truncated: "abcd",
        wrongType: 42,
      }),
    }),
  );
  assert.deepEqual(encryptedChannelIds(), ["good"]);
});

test("the env value parses channel=key pairs on commas and newlines", () => {
  const { entries, warnings } = parseChannelKeyEnv(
    `engineering=${KEY_HEX}, design=${OTHER_KEY_HEX}\n\n`,
  );

  assert.deepEqual(warnings, []);
  assert.deepEqual(
    entries.map((entry) => entry.channelId),
    ["engineering", "design"],
  );
  assert.equal(formatChannelKey(entries[0].key), KEY_HEX);
});

test("a malformed env pair is reported without echoing the secret", () => {
  const { entries, warnings } = parseChannelKeyEnv(
    `engineering=nothexatall, =${KEY_HEX}, lonely`,
  );

  assert.deepEqual(entries, []);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => warning.includes("engineering")));
  assert.ok(!warnings.join(" ").includes("nothexatall"));
});

test("an unset env seeds nothing and leaves stored keys alone", () => {
  setChannelKey("engineering", parseChannelKey(KEY_HEX));

  assert.deepEqual(seedChannelKeysFromEnv({}), []);
  assert.equal(formatChannelKey(getChannelKey("engineering")), KEY_HEX);
});

test("the env overrides a stored key and persists the override", () => {
  // Whoever launched the process gave the more recent instruction, and a
  // harness that cannot override a stale key cannot test anything.
  setChannelKey("engineering", parseChannelKey(KEY_HEX));

  seedChannelKeysFromEnv({ BUZZ_CHANNEL_KEYS: `engineering=${OTHER_KEY_HEX}` });
  assert.equal(formatChannelKey(getChannelKey("engineering")), OTHER_KEY_HEX);

  setChannelKeyStorage(disk);
  assert.equal(formatChannelKey(getChannelKey("engineering")), OTHER_KEY_HEX);
});

test("a store with no window falls back to memory rather than throwing", () => {
  setChannelKeyStorage(null);

  const key = generateChannelKey();
  setChannelKey("engineering", key);
  assert.deepEqual(getChannelKey("engineering"), key);
});
