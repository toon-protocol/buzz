import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  channelKeyId,
  formatChannelKey,
  generateChannelKey,
  parseChannelKey,
} from "./channelEncryption.ts";
import {
  adoptChannelKey,
  channelKeyRecord,
  encryptedChannelIds,
  findChannelKey,
  getChannelKey,
  getChannelKeys,
  hasChannelKey,
  parseChannelKeyEnv,
  promoteChannelKey,
  reloadChannelKeys,
  seedChannelKeysFromEnv,
  setChannelKey,
  setChannelKeyStorage,
  subscribeToChannelKeys,
} from "./channelKeyStore.ts";

const KEY_HEX = "b".repeat(64);
const OTHER_KEY_HEX = "c".repeat(64);
const THIRD_KEY_HEX = "e".repeat(64);

/** Key ids, so a ring can be asserted by identity rather than by bytes. */
function ringIds(channelId) {
  return getChannelKeys(channelId).map(channelKeyId);
}

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
  setChannelKeyStorage(fakeDisk({ "buzz-channel-keys.v2": "{not json" }));
  assert.deepEqual(encryptedChannelIds(), []);

  setChannelKeyStorage(
    fakeDisk({
      "buzz-channel-keys.v2": JSON.stringify({
        version: 2,
        channels: {
          good: [KEY_HEX],
          truncated: ["abcd"],
          wrongType: 42,
          empty: [],
        },
      }),
    }),
  );
  assert.deepEqual(encryptedChannelIds(), ["good"]);
});

test("a v1 record migrates to a one-key ring and is then removed", () => {
  // v1's whole store was `{ channelId: hexKey }`. Rotation needs a ring, and
  // an installed client's keys are not re-derivable — losing them here loses
  // the channel, not just the tail.
  const legacy = fakeDisk({
    "buzz-channel-keys.v1": JSON.stringify({
      engineering: KEY_HEX,
      design: OTHER_KEY_HEX,
      truncated: "abcd",
    }),
  });
  setChannelKeyStorage(legacy);

  assert.deepEqual(encryptedChannelIds(), ["engineering", "design"]);
  assert.equal(formatChannelKey(getChannelKey("engineering")), KEY_HEX);
  assert.equal(getChannelKeys("engineering").length, 1);

  // Rewritten in the v2 shape, and the v1 record is gone — leaving it would
  // keep a copy of every key that "Forget key" and rotation both promise to
  // have moved on from.
  assert.equal(legacy.values.has("buzz-channel-keys.v1"), false);
  assert.deepEqual(JSON.parse(legacy.values.get("buzz-channel-keys.v2")), {
    version: 2,
    channels: { engineering: [KEY_HEX], design: [OTHER_KEY_HEX] },
  });

  // And the migration is a one-off: a restart reads v2 and finds the same keys.
  setChannelKeyStorage(legacy);
  assert.equal(formatChannelKey(getChannelKey("design")), OTHER_KEY_HEX);
});

test("a v2 record survives a restart with its ring order intact", () => {
  // Order is the state model: index 0 is what the channel sends with.
  setChannelKey("engineering", parseChannelKey(KEY_HEX));
  adoptChannelKey("engineering", parseChannelKey(OTHER_KEY_HEX));

  setChannelKeyStorage(disk);

  assert.deepEqual(ringIds("engineering"), [
    channelKeyId(parseChannelKey(KEY_HEX)),
    channelKeyId(parseChannelKey(OTHER_KEY_HEX)),
  ]);
});

test("an adopted key is readable without becoming the key we send with", () => {
  // A rotation key arrives before the admin list that names its epoch. Sealing
  // under it early would produce messages the rest of the channel cannot open.
  setChannelKey("engineering", parseChannelKey(KEY_HEX));
  const rotated = parseChannelKey(OTHER_KEY_HEX);

  assert.equal(adoptChannelKey("engineering", rotated), true);
  assert.equal(formatChannelKey(getChannelKey("engineering")), KEY_HEX);
  assert.deepEqual(
    findChannelKey("engineering", channelKeyId(rotated)),
    rotated,
  );
  assert.deepEqual(channelKeyRecord(), { engineering: KEY_HEX });
});

test("the first key a channel is given is the one it sends with", () => {
  const key = parseChannelKey(KEY_HEX);

  assert.equal(adoptChannelKey("engineering", key), true);
  assert.deepEqual(getChannelKey("engineering"), key);
});

test("re-adopting a superseded key does not move it back to the front", () => {
  // A relay re-delivering a pre-rotation wrap must not be able to put the
  // channel back on an epoch a removed member still holds.
  const first = parseChannelKey(KEY_HEX);
  const second = parseChannelKey(OTHER_KEY_HEX);
  setChannelKey("engineering", first);
  setChannelKey("engineering", second);
  assert.deepEqual(ringIds("engineering"), [
    channelKeyId(second),
    channelKeyId(first),
  ]);

  assert.equal(adoptChannelKey("engineering", first), false);
  assert.deepEqual(getChannelKey("engineering"), second);
});

test("a held key is promoted when the channel announces its epoch", () => {
  const current = parseChannelKey(KEY_HEX);
  const rotated = parseChannelKey(OTHER_KEY_HEX);
  setChannelKey("engineering", current);
  adoptChannelKey("engineering", rotated);

  assert.equal(promoteChannelKey("engineering", channelKeyId(rotated)), true);
  assert.deepEqual(getChannelKey("engineering"), rotated);
  assert.deepEqual(ringIds("engineering"), [
    channelKeyId(rotated),
    channelKeyId(current),
  ]);

  // Already at the front, and never held at all: both are no-ops, not errors.
  assert.equal(promoteChannelKey("engineering", channelKeyId(rotated)), false);
  assert.equal(
    promoteChannelKey(
      "engineering",
      channelKeyId(parseChannelKey(THIRD_KEY_HEX)),
    ),
    false,
  );
  assert.equal(promoteChannelKey("never-keyed", channelKeyId(rotated)), false);
});

test("forgetting a channel forgets every epoch of it", () => {
  setChannelKey("engineering", parseChannelKey(KEY_HEX));
  adoptChannelKey("engineering", parseChannelKey(OTHER_KEY_HEX));

  setChannelKey("engineering", null);

  setChannelKeyStorage(disk);
  assert.deepEqual(getChannelKeys("engineering"), []);
  assert.equal(hasChannelKey("engineering"), false);
});

test("a ring is bounded, dropping the oldest epoch first", () => {
  const keys = Array.from({ length: 20 }, () => generateChannelKey());
  for (const key of keys) setChannelKey("engineering", key);

  const ring = ringIds("engineering");
  assert.equal(ring.length, 16);
  // Newest first: the last key set is what the channel sends with.
  assert.equal(ring[0], channelKeyId(keys.at(-1)));
  assert.equal(ring.includes(channelKeyId(keys[0])), false);
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
