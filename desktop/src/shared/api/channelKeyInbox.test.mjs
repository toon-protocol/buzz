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
} from "./channelAdminList.ts";
import { resetChannelAdminLists } from "./channelAdminListStore.ts";
import { channelKeyId, generateChannelKey } from "./channelEncryption.ts";
import { wrapChannelKey } from "./channelKeyDelivery.ts";
import { startChannelKeyInbox } from "./channelKeyInbox.ts";
import { getChannelKey, setChannelKeyStorage } from "./channelKeyStore.ts";
import {
  LOCKED_MESSAGE_PLACEHOLDER,
  openChannelEvent,
  sealChannelContent,
} from "./channelMessageCrypto.ts";

const CHANNEL = "0a1b-secret-channel";

function identity() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

const admin = identity();
const member = identity();
const outsider = identity();

/** As it arrives from a relay: plain JSON, no memoised verification symbol. */
function fromWire(event) {
  return JSON.parse(JSON.stringify(event));
}

function signedAdminList(signer, admins, keyId, createdAt = 1_700_000_000) {
  return fromWire(
    finalizeEvent(
      {
        ...buildChannelAdminListEvent({
          channelId: CHANNEL,
          creator: admin.pubkey,
          admins,
          keyId,
        }),
        created_at: createdAt,
      },
      signer.secretKey,
    ),
  );
}

/**
 * A transport that hands out whatever the test pushes into it.
 *
 * Matches the seam's shape (`subscribeLive`: filter in, dispose out) and
 * routes by kind, which is all the inbox's two subscriptions differ by. Events
 * pushed before a subscription exists are replayed to it — that is what a
 * relay's stored-events backlog does, and it is the ordering the inbox has to
 * survive.
 */
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

/** A message the admin posted before the member had the key. */
function encryptedHistory(key) {
  const sealed = sealChannelContent(CHANNEL, "the quiet part", key);
  return {
    id: "e".repeat(64),
    pubkey: admin.pubkey,
    created_at: 1_700_000_050,
    kind: 9,
    tags: [["h", CHANNEL], ...sealed.tags],
    content: sealed.content,
    sig: "0".repeat(128),
  };
}

function memoryDisk() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

let transport;
let reported;

function startInbox(who = member) {
  return startChannelKeyInbox({
    pubkey: who.pubkey,
    secretKey: who.secretKey,
    subscribe: transport.subscribe,
    onEvent: (event) => reported.push(event),
  });
}

beforeEach(() => {
  setChannelKeyStorage(memoryDisk());
  resetChannelAdminLists();
  transport = fakeTransport();
  reported = [];
});

test("an admin's gift wrap unlocks the channel and its history", async () => {
  const key = generateChannelKey();
  const history = encryptedHistory(key);

  // Before the key: the timeline shows a locked placeholder.
  assert.equal(openChannelEvent(history).content, LOCKED_MESSAGE_PLACEHOLDER);

  transport.deliver(
    signedAdminList(admin, [admin.pubkey], channelKeyId(key)),
    fromWire(
      wrapChannelKey({
        channelId: CHANNEL,
        key,
        recipient: member.pubkey,
        senderSecretKey: admin.secretKey,
      }),
    ),
  );

  const inbox = await startInbox();

  assert.equal(channelKeyId(getChannelKey(CHANNEL)), channelKeyId(key));
  assert.equal(openChannelEvent(history).content, "the quiet part");
  assert.deepEqual(reported, [
    {
      type: "unlocked",
      channelId: CHANNEL,
      keyId: channelKeyId(key),
      sender: admin.pubkey,
    },
  ]);

  await inbox.stop();
});

test("a wrap that lands before the admin list is held, then honoured", async () => {
  const key = generateChannelKey();
  const inbox = await startInbox();

  transport.deliver(
    fromWire(
      wrapChannelKey({
        channelId: CHANNEL,
        key,
        recipient: member.pubkey,
        senderSecretKey: admin.secretKey,
      }),
    ),
  );

  assert.equal(getChannelKey(CHANNEL), null);
  assert.deepEqual(inbox.heldChannelIds(), [CHANNEL]);
  assert.deepEqual(reported, [
    { type: "held", channelId: CHANNEL, sender: admin.pubkey },
  ]);

  transport.deliver(signedAdminList(admin, [admin.pubkey], channelKeyId(key)));

  assert.equal(channelKeyId(getChannelKey(CHANNEL)), channelKeyId(key));
  assert.deepEqual(inbox.heldChannelIds(), []);

  await inbox.stop();
});

test("a key wrapped by a non-admin never unlocks the channel", async () => {
  const real = generateChannelKey();
  const forged = generateChannelKey();

  transport.deliver(
    signedAdminList(admin, [admin.pubkey], channelKeyId(real)),
    fromWire(
      wrapChannelKey({
        channelId: CHANNEL,
        key: forged,
        recipient: member.pubkey,
        senderSecretKey: outsider.secretKey,
      }),
    ),
  );

  const inbox = await startInbox();

  assert.equal(getChannelKey(CHANNEL), null);
  assert.deepEqual(inbox.heldChannelIds(), []);
  assert.deepEqual(reported, [
    {
      type: "rejected",
      channelId: CHANNEL,
      sender: outsider.pubkey,
      reason: "sender-not-admin",
    },
  ]);

  await inbox.stop();
});

test("an admin list forged by the outsider does not make their key acceptable", async () => {
  const forged = generateChannelKey();

  transport.deliver(
    // A real chain rooted in the admin...
    signedAdminList(admin, [admin.pubkey], "0123456789abcdef"),
    // ...and the outsider's attempt to append themselves to it.
    signedAdminList(
      outsider,
      [admin.pubkey, outsider.pubkey],
      channelKeyId(forged),
      1_700_000_500,
    ),
    fromWire(
      wrapChannelKey({
        channelId: CHANNEL,
        key: forged,
        recipient: member.pubkey,
        senderSecretKey: outsider.secretKey,
      }),
    ),
  );

  const inbox = await startInbox();

  assert.equal(getChannelKey(CHANNEL), null);
  assert.equal(reported.at(-1).type, "rejected");

  await inbox.stop();
});

test("a promoted admin can hand out the key", async () => {
  const key = generateChannelKey();

  transport.deliver(
    signedAdminList(admin, [admin.pubkey], channelKeyId(key)),
    signedAdminList(
      admin,
      [admin.pubkey, outsider.pubkey],
      channelKeyId(key),
      1_700_000_500,
    ),
    fromWire(
      wrapChannelKey({
        channelId: CHANNEL,
        key,
        recipient: member.pubkey,
        senderSecretKey: outsider.secretKey,
      }),
    ),
  );

  const inbox = await startInbox();

  assert.equal(channelKeyId(getChannelKey(CHANNEL)), channelKeyId(key));

  await inbox.stop();
});

test("a re-delivered wrap does not re-report or re-apply", async () => {
  const key = generateChannelKey();
  const wrap = fromWire(
    wrapChannelKey({
      channelId: CHANNEL,
      key,
      recipient: member.pubkey,
      senderSecretKey: admin.secretKey,
    }),
  );

  transport.deliver(
    signedAdminList(admin, [admin.pubkey], channelKeyId(key)),
    wrap,
  );
  const inbox = await startInbox();
  transport.deliver(wrap);

  assert.equal(reported.length, 1);

  await inbox.stop();
});

test("wraps for other people are not even noticed", async () => {
  const key = generateChannelKey();

  transport.deliver(
    signedAdminList(admin, [admin.pubkey], channelKeyId(key)),
    fromWire(
      wrapChannelKey({
        channelId: CHANNEL,
        key,
        recipient: outsider.pubkey,
        senderSecretKey: admin.secretKey,
      }),
    ),
  );

  const inbox = await startInbox();

  assert.equal(getChannelKey(CHANNEL), null);
  assert.deepEqual(reported, []);

  await inbox.stop();
});

test("stopping the inbox drops both subscriptions", async () => {
  const key = generateChannelKey();
  const inbox = await startInbox();
  await inbox.stop();

  transport.deliver(
    signedAdminList(admin, [admin.pubkey], channelKeyId(key)),
    fromWire(
      wrapChannelKey({
        channelId: CHANNEL,
        key,
        recipient: member.pubkey,
        senderSecretKey: admin.secretKey,
      }),
    ),
  );

  assert.equal(getChannelKey(CHANNEL), null);
  assert.deepEqual(reported, []);
});

test("the admin-list subscription asks for admin lists, the other for wraps", async () => {
  const filters = [];
  const inbox = await startChannelKeyInbox({
    pubkey: member.pubkey,
    secretKey: member.secretKey,
    subscribe: async (filter) => {
      filters.push(filter);
      return async () => {};
    },
    onEvent: () => {},
  });

  assert.deepEqual(
    filters.map((filter) => filter.kinds),
    [[CHANNEL_ADMIN_LIST_KIND], [1059]],
  );
  assert.deepEqual(filters[1]["#p"], [member.pubkey]);

  await inbox.stop();
});
