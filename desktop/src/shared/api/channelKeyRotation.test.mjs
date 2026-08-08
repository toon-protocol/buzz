import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  buildChannelAdminListEvent,
  CHANNEL_ADMIN_LIST_KIND,
  resolveChannelAdminList,
} from "./channelAdminList.ts";
import {
  recordChannelAdminListEvent,
  resetChannelAdminLists,
} from "./channelAdminListStore.ts";
import {
  channelKeyId,
  formatChannelKey,
  generateChannelKey,
} from "./channelEncryption.ts";
import { installChannelKeyEpochSync } from "./channelKeyEpoch.ts";
import { startChannelKeyInbox } from "./channelKeyInbox.ts";
import { rotateChannelKeyForRemoval } from "./channelKeyRotation.ts";
import {
  channelKeyRecord,
  getChannelKey,
  getChannelKeys,
  setChannelKey,
  setChannelKeyStorage,
} from "./channelKeyStore.ts";
import {
  LOCKED_MESSAGE_PLACEHOLDER,
  openChannelEvent,
  sealChannelContent,
} from "./channelMessageCrypto.ts";
import { KIND_GIFT_WRAP } from "../constants/kinds.ts";

const CHANNEL = "0a1b-secret-channel";

function identity() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/** Creator/admin, a member who stays, a member who is removed, a co-admin. */
const owner = identity();
const survivor = identity();
const removed = identity();
const coAdmin = identity();

/** As it arrives from a relay: plain JSON, no memoised verification symbol. */
function fromWire(event) {
  return JSON.parse(JSON.stringify(event));
}

function memoryDisk() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

/**
 * Ports that sign for real and record every publish in order.
 *
 * Signing has to be genuine: the survivors' clients verify the admin list's
 * signature before believing a word of it, so a stub would test nothing about
 * whether a rotation is actually accepted.
 */
function rotationPorts(who, options = {}) {
  const published = [];
  let clock = options.startedAt ?? 1_700_000_100;
  return {
    published,
    ports: {
      identity: async () => ({ pubkey: who.pubkey }),
      secretKey: async () => who.secretKey,
      sign: async (template) => {
        clock += 1;
        return fromWire(
          finalizeEvent({ ...template, created_at: clock }, who.secretKey),
        );
      },
      publish: async (event) => {
        if (options.failFor?.(event)) throw new Error("paid write rejected");
        published.push(event);
        return event;
      },
      ready: async () => {},
      freshKey: generateChannelKey,
    },
  };
}

/** The genesis admin list: the owner, naming themselves, on epoch 0. */
function genesisList(key, admins = [owner.pubkey], createdAt = 1_700_000_000) {
  return fromWire(
    finalizeEvent(
      {
        ...buildChannelAdminListEvent({
          channelId: CHANNEL,
          creator: owner.pubkey,
          admins,
          keyId: channelKeyId(key),
          epoch: 0,
        }),
        created_at: createdAt,
      },
      owner.secretKey,
    ),
  );
}

/** A channel message sealed under `key`, as it lands from the relay. */
function message(key, text, id = "e".repeat(64)) {
  const sealed = sealChannelContent(CHANNEL, text, key);
  return {
    id,
    pubkey: owner.pubkey,
    created_at: 1_700_000_200,
    kind: 9,
    tags: [["h", CHANNEL], ...sealed.tags],
    content: sealed.content,
    sig: "0".repeat(128),
  };
}

/** Recipients a gift wrap is addressed to. The only routing it carries. */
function wrapRecipients(event) {
  return event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]);
}

/** The same fake relay `channelKeyInbox.test.mjs` uses: routes by kind. */
function fakeTransport() {
  const listeners = [];
  const delivered = [];

  return {
    subscribe: async (filter, onEvent) => {
      const entry = { kinds: new Set(filter.kinds), onEvent };
      listeners.push(entry);
      for (const event of delivered) {
        if (entry.kinds.has(event.kind)) entry.onEvent(event);
      }
      return async () => {
        listeners.splice(listeners.indexOf(entry), 1);
      };
    },
    deliver(...events) {
      for (const event of events) {
        delivered.push(event);
        for (const entry of listeners) {
          if (entry.kinds.has(event.kind)) entry.onEvent(event);
        }
      }
    },
  };
}

/** Become a different client: their disk, their view of the admin lists. */
function asClient() {
  setChannelKeyStorage(memoryDisk());
  resetChannelAdminLists();
}

beforeEach(() => {
  asClient();
});

/**
 * Set up the owner's client mid-channel: it holds the key and has a resolved
 * admin list. Returns the old key and the rotation's recorded publishes.
 */
async function rotate({ admins = [owner.pubkey], removedPubkeys, remaining }) {
  const oldKey = generateChannelKey();
  setChannelKey(CHANNEL, oldKey);
  const genesis = genesisList(oldKey, admins);
  recordChannelAdminListEvent(genesis);

  const { ports, published } = rotationPorts(owner);
  const outcome = await rotateChannelKeyForRemoval(
    { channelId: CHANNEL, removed: removedPubkeys, remaining },
    ports,
  );

  return { genesis, oldKey, outcome, published };
}

test("rotation publishes every wrap before the admin list that names it", async () => {
  // The order is the feature. A list that lands first names an epoch whose key
  // nobody holds, which every survivor reads as "I have been removed".
  const { outcome, published } = await rotate({
    removedPubkeys: [removed.pubkey],
    remaining: [owner.pubkey, survivor.pubkey, coAdmin.pubkey],
  });

  assert.equal(outcome.rotated, true);
  assert.deepEqual(
    published.map((event) => event.kind),
    [KIND_GIFT_WRAP, KIND_GIFT_WRAP, CHANNEL_ADMIN_LIST_KIND],
  );
  assert.deepEqual(outcome.delivered, [survivor.pubkey, coAdmin.pubkey]);
  assert.deepEqual(outcome.skipped, []);
});

test("nothing published carries the new key to the removed member", async () => {
  const { outcome, published } = await rotate({
    // A stale roster that still lists the removed member: the caller's
    // members query may predate the removal, and re-wrapping the key to them
    // would undo the rotation in the same breath as performing it.
    removedPubkeys: [removed.pubkey],
    remaining: [survivor.pubkey, removed.pubkey],
  });

  const wraps = published.filter((event) => event.kind === KIND_GIFT_WRAP);
  assert.equal(wraps.length, 1);
  assert.deepEqual(wrapRecipients(wraps[0]), [survivor.pubkey]);
  assert.deepEqual(outcome.delivered, [survivor.pubkey]);

  // The admin list names the epoch in public, but a key id is a one-way hash
  // (channelEncryption's KEY_ID_DOMAIN) — it is not the key. Nothing the
  // rotation published carries the bytes in a form the removed member can use.
  const newKeyHex = formatChannelKey(getChannelKey(CHANNEL));
  assert.equal(published.at(-1).content, "");
  assert.equal(published.at(-1).kind, CHANNEL_ADMIN_LIST_KIND);
  assert.ok(!JSON.stringify(published).includes(newKeyHex));
  assert.equal(outcome.keyId, channelKeyId(getChannelKey(CHANNEL)));
});

test("the admin list moves to the next epoch and drops the removed admin", async () => {
  const { genesis, outcome, published } = await rotate({
    admins: [owner.pubkey, coAdmin.pubkey],
    removedPubkeys: [coAdmin.pubkey],
    remaining: [owner.pubkey, survivor.pubkey],
  });

  // Resolved the way any other client will resolve it: signature checked, fold
  // rooted at the genesis the owner signed. One event demotes them and moves
  // the epoch, so no client ever sees a state where only one has happened.
  const resolved = resolveChannelAdminList(
    [genesis, ...published].filter(
      (event) => event.kind === CHANNEL_ADMIN_LIST_KIND,
    ),
    { channelId: CHANNEL, creator: owner.pubkey },
  );

  assert.deepEqual(resolved.admins, [owner.pubkey]);
  assert.equal(resolved.epoch, 1);
  assert.equal(resolved.keyId, outcome.keyId);
  // And they were sent no wrap, so the demotion is not merely nominal.
  const wraps = published.filter((event) => event.kind === KIND_GIFT_WRAP);
  assert.deepEqual(wraps.flatMap(wrapRecipients), [survivor.pubkey]);
});

test("an admin can rotate without removing anyone, for a suspected key leak", async () => {
  // buzz#42: the "this key may have leaked" trigger. No removal rides along —
  // the admin list is unchanged apart from the epoch, and everyone but the
  // calling admin gets the fresh key.
  const { genesis, outcome, published } = await rotate({
    admins: [owner.pubkey, coAdmin.pubkey],
    removedPubkeys: [],
    remaining: [owner.pubkey, survivor.pubkey, coAdmin.pubkey],
  });

  const resolved = resolveChannelAdminList(
    [genesis, ...published].filter(
      (event) => event.kind === CHANNEL_ADMIN_LIST_KIND,
    ),
    { channelId: CHANNEL, creator: owner.pubkey },
  );

  assert.equal(outcome.rotated, true);
  assert.deepEqual(resolved.admins, [owner.pubkey, coAdmin.pubkey]);
  assert.equal(resolved.epoch, 1);
  assert.deepEqual(outcome.delivered, [survivor.pubkey, coAdmin.pubkey]);
  assert.deepEqual(outcome.skipped, []);
});

test("a non-creator admin can rotate themselves out when they leave voluntarily", async () => {
  // buzz#42: the voluntary-leave trigger. The leaving admin is both the
  // caller and the removed pubkey — self-initiated, nobody else has to
  // notice and act on their behalf.
  const oldKey = generateChannelKey();
  setChannelKey(CHANNEL, oldKey);
  const genesis = genesisList(oldKey, [owner.pubkey, coAdmin.pubkey]);
  recordChannelAdminListEvent(genesis);

  const { ports, published } = rotationPorts(coAdmin);
  const outcome = await rotateChannelKeyForRemoval(
    {
      channelId: CHANNEL,
      removed: [coAdmin.pubkey],
      remaining: [owner.pubkey],
    },
    ports,
  );

  assert.equal(outcome.rotated, true);
  const resolved = resolveChannelAdminList(
    [genesis, ...published].filter(
      (event) => event.kind === CHANNEL_ADMIN_LIST_KIND,
    ),
    { channelId: CHANNEL, creator: owner.pubkey },
  );
  assert.deepEqual(resolved.admins, [owner.pubkey]);
  assert.deepEqual(outcome.delivered, [owner.pubkey]);
});

test("the creator leaving still rotates the key, but stays on the list", async () => {
  // buzz#18's admin-list builder never drops the creator, so a creator who
  // leaves voluntarily loses the content like anyone else while their name
  // stays on the list — re-rooting the channel to a new creator is a
  // separate, unbuilt feature (buzz#42's scope explicitly excludes it).
  const oldKey = generateChannelKey();
  setChannelKey(CHANNEL, oldKey);
  const genesis = genesisList(oldKey, [owner.pubkey]);
  recordChannelAdminListEvent(genesis);

  const { ports, published } = rotationPorts(owner);
  const outcome = await rotateChannelKeyForRemoval(
    {
      channelId: CHANNEL,
      removed: [owner.pubkey],
      remaining: [survivor.pubkey],
    },
    ports,
  );

  assert.equal(outcome.rotated, true);
  const resolved = resolveChannelAdminList(
    [genesis, ...published].filter(
      (event) => event.kind === CHANNEL_ADMIN_LIST_KIND,
    ),
    { channelId: CHANNEL, creator: owner.pubkey },
  );
  assert.deepEqual(resolved.admins, [owner.pubkey]);
  assert.equal(resolved.epoch, 1);
  assert.deepEqual(outcome.delivered, [survivor.pubkey]);
});

test("the rotating admin switches to the new key and keeps the old one", async () => {
  const { oldKey, outcome } = await rotate({
    removedPubkeys: [removed.pubkey],
    remaining: [survivor.pubkey],
  });

  const ring = getChannelKeys(CHANNEL);
  assert.equal(ring.length, 2);
  assert.equal(channelKeyId(ring[0]), outcome.keyId);
  assert.equal(channelKeyId(ring[1]), channelKeyId(oldKey));

  // What Rust is handed (`sync_channel_keys`): the sending key and only it, so
  // a Rust-built event seals under the new epoch too. The superseded key is
  // gone from that side — the sync replaces rather than merges.
  assert.deepEqual(channelKeyRecord(), {
    [CHANNEL]: formatChannelKey(ring[0]),
  });

  // And history sealed before the rotation still opens.
  assert.equal(openChannelEvent(message(oldKey, "before")).content, "before");
});

test("a survivor unlocks the new epoch with no manual step", async () => {
  const { oldKey, outcome, published } = await rotate({
    removedPubkeys: [removed.pubkey],
    remaining: [survivor.pubkey],
  });
  const newKey = getChannelKey(CHANNEL);
  const history = message(oldKey, "before the removal", "a".repeat(64));
  const afterwards = message(newKey, "after the removal", "b".repeat(64));
  const wraps = published.filter((event) => event.kind === KIND_GIFT_WRAP);
  const rotatedList = published.at(-1);

  // Now be the survivor: their disk, their key, their view of the channel.
  asClient();
  setChannelKey(CHANNEL, oldKey);
  const transport = fakeTransport();
  const stopEpochSync = installChannelKeyEpochSync();
  transport.deliver(genesisList(oldKey));
  const inbox = await startChannelKeyInbox({
    pubkey: survivor.pubkey,
    getSecretKey: async () => survivor.secretKey,
    subscribe: transport.subscribe,
    onEvent: () => {},
  });

  // The wrap lands first — that is the order rotation publishes in — and is
  // validated against the PRE-rotation list, where its sender is still an
  // admin. Accepting it is the whole reason the wraps go first.
  transport.deliver(...wraps);
  await inbox.settled();

  assert.equal(getChannelKeys(CHANNEL).length, 2);
  assert.equal(openChannelEvent(afterwards).content, "after the removal");
  // Held for reading, not yet for sending: the channel has not announced the
  // new epoch, so sealing under it would produce messages nobody can open.
  assert.equal(channelKeyId(getChannelKey(CHANNEL)), channelKeyId(oldKey));

  transport.deliver(rotatedList);
  await inbox.settled();

  // The list is the signal to switch. Both epochs stay readable.
  assert.equal(channelKeyId(getChannelKey(CHANNEL)), outcome.keyId);
  assert.equal(openChannelEvent(history).content, "before the removal");
  assert.equal(openChannelEvent(afterwards).content, "after the removal");

  stopEpochSync();
  await inbox.stop();
});

test("a survivor whose list arrives before the wrap still switches", async () => {
  // The relay may reorder anything. Promotion is driven from both sides: the
  // admin-list subscription, and the adoption site.
  const { oldKey, outcome, published } = await rotate({
    removedPubkeys: [removed.pubkey],
    remaining: [survivor.pubkey],
  });
  const wraps = published.filter((event) => event.kind === KIND_GIFT_WRAP);
  const rotatedList = published.at(-1);

  asClient();
  setChannelKey(CHANNEL, oldKey);
  const transport = fakeTransport();
  const stopEpochSync = installChannelKeyEpochSync();
  transport.deliver(genesisList(oldKey));
  const inbox = await startChannelKeyInbox({
    pubkey: survivor.pubkey,
    getSecretKey: async () => survivor.secretKey,
    subscribe: transport.subscribe,
    onEvent: () => {},
  });

  transport.deliver(rotatedList);
  await inbox.settled();
  // Nothing to promote: the list names a key this client has not been sent.
  assert.equal(channelKeyId(getChannelKey(CHANNEL)), channelKeyId(oldKey));

  transport.deliver(...wraps);
  await inbox.settled();
  assert.equal(channelKeyId(getChannelKey(CHANNEL)), outcome.keyId);

  stopEpochSync();
  await inbox.stop();
});

test("the removed member keeps history and loses everything after", async () => {
  // ADR 0001's Slack-export semantics, as an assertion: rotation protects the
  // future, and cannot pretend to protect the past.
  const { oldKey, published } = await rotate({
    removedPubkeys: [removed.pubkey],
    remaining: [survivor.pubkey],
  });
  const newKey = getChannelKey(CHANNEL);
  const history = message(oldKey, "said before they left", "a".repeat(64));
  const afterwards = message(newKey, "said after they left", "b".repeat(64));

  asClient();
  setChannelKey(CHANNEL, oldKey);
  const transport = fakeTransport();
  const stopEpochSync = installChannelKeyEpochSync();
  const inbox = await startChannelKeyInbox({
    pubkey: removed.pubkey,
    getSecretKey: async () => removed.secretKey,
    subscribe: transport.subscribe,
    onEvent: () => {},
  });

  // Everything the rotation put on the relay — they can read all of it, since
  // reads are free and public. None of it is a key for them.
  transport.deliver(genesisList(oldKey), ...published);
  await inbox.settled();

  assert.equal(getChannelKeys(CHANNEL).length, 1);
  assert.equal(channelKeyId(getChannelKey(CHANNEL)), channelKeyId(oldKey));
  assert.equal(openChannelEvent(history).content, "said before they left");
  assert.equal(
    openChannelEvent(afterwards).content,
    LOCKED_MESSAGE_PLACEHOLDER,
  );

  stopEpochSync();
  await inbox.stop();
});

test("a wrap that fails to publish does not cancel the others", async () => {
  const oldKey = generateChannelKey();
  setChannelKey(CHANNEL, oldKey);
  recordChannelAdminListEvent(genesisList(oldKey));

  const { ports, published } = rotationPorts(owner, {
    failFor: (event) =>
      event.kind === KIND_GIFT_WRAP &&
      wrapRecipients(event).includes(survivor.pubkey),
  });
  const outcome = await rotateChannelKeyForRemoval(
    {
      channelId: CHANNEL,
      removed: [removed.pubkey],
      remaining: [survivor.pubkey, coAdmin.pubkey],
    },
    ports,
  );

  assert.equal(outcome.rotated, true);
  assert.deepEqual(outcome.delivered, [coAdmin.pubkey]);
  assert.deepEqual(
    outcome.skipped.map((skip) => skip.pubkey),
    [survivor.pubkey],
  );
  assert.equal(published.at(-1).kind, CHANNEL_ADMIN_LIST_KIND);
});

test("an unencrypted channel is a roster change and nothing else", async () => {
  const { ports, published } = rotationPorts(owner);
  const outcome = await rotateChannelKeyForRemoval(
    { channelId: CHANNEL, removed: [removed.pubkey], remaining: [] },
    ports,
  );

  assert.deepEqual(outcome, {
    rotated: false,
    reason: "channel-not-encrypted",
  });
  assert.deepEqual(published, []);
});

test("a channel with no validated admin list is not rotated", async () => {
  setChannelKey(CHANNEL, generateChannelKey());

  const { ports, published } = rotationPorts(owner);
  const outcome = await rotateChannelKeyForRemoval(
    { channelId: CHANNEL, removed: [removed.pubkey], remaining: [] },
    ports,
  );

  // Publishing a list for a channel whose chain this client cannot see would
  // fork it — the same refusal `announceChannelKey` makes.
  assert.deepEqual(outcome, { rotated: false, reason: "no-admin-list" });
  assert.deepEqual(published, []);
});

test("a non-admin cannot rotate, and burns no paid write trying", async () => {
  const key = generateChannelKey();
  setChannelKey(CHANNEL, key);
  recordChannelAdminListEvent(genesisList(key));

  const { ports, published } = rotationPorts(survivor);
  const outcome = await rotateChannelKeyForRemoval(
    { channelId: CHANNEL, removed: [removed.pubkey], remaining: [] },
    ports,
  );

  assert.deepEqual(outcome, { rotated: false, reason: "not-an-admin" });
  assert.deepEqual(published, []);
  assert.equal(channelKeyId(getChannelKey(CHANNEL)), channelKeyId(key));
});
