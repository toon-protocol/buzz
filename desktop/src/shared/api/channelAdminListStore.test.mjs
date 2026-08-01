import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import { buildChannelAdminListEvent } from "./channelAdminList.ts";
import {
  getChannelAdminList,
  knownAdminListChannelIds,
  pinChannelCreator,
  recordChannelAdminListEvent,
  resetChannelAdminLists,
  subscribeToChannelAdminLists,
} from "./channelAdminListStore.ts";

const CHANNEL = "store-test-channel";

function identity() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

const alice = identity();
const mallory = identity();

function signedList(signer, input, createdAt) {
  return JSON.parse(
    JSON.stringify(
      finalizeEvent(
        { ...buildChannelAdminListEvent(input), created_at: createdAt },
        signer.secretKey,
      ),
    ),
  );
}

const genesis = signedList(
  alice,
  { channelId: CHANNEL, creator: alice.pubkey, admins: [alice.pubkey] },
  1_700_000_000,
);

beforeEach(() => {
  resetChannelAdminLists();
});

test("an unknown channel has no admin list", () => {
  assert.equal(getChannelAdminList(CHANNEL), null);
  assert.deepEqual(knownAdminListChannelIds(), []);
});

test("an event that is not an admin list is not recorded", () => {
  const note = JSON.parse(
    JSON.stringify(
      finalizeEvent(
        { kind: 1, content: "hi", created_at: 1_700_000_000, tags: [] },
        alice.secretKey,
      ),
    ),
  );
  assert.equal(recordChannelAdminListEvent(note), false);
  assert.deepEqual(knownAdminListChannelIds(), []);
});

test("only the newest event per signer is kept", () => {
  const newer = signedList(
    alice,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey],
      keyId: "1111111111111111",
      epoch: 1,
    },
    1_700_000_500,
  );

  assert.equal(recordChannelAdminListEvent(genesis), true);
  assert.equal(recordChannelAdminListEvent(newer), true);
  // A late backfill of the superseded event must not resurrect it.
  assert.equal(recordChannelAdminListEvent(genesis), false);
  assert.equal(recordChannelAdminListEvent(newer), false);

  assert.equal(getChannelAdminList(CHANNEL).epoch, 1);
});

test("the first resolved creator is pinned against a backdated genesis", () => {
  recordChannelAdminListEvent(genesis);
  assert.equal(getChannelAdminList(CHANNEL).creator, alice.pubkey);

  // Mallory turns up later claiming to have created the channel first.
  recordChannelAdminListEvent(
    signedList(
      mallory,
      {
        channelId: CHANNEL,
        creator: mallory.pubkey,
        admins: [mallory.pubkey],
      },
      1_699_000_000,
    ),
  );

  assert.equal(getChannelAdminList(CHANNEL).creator, alice.pubkey);
});

test("a creator pinned up front wins even on the very first resolution", () => {
  pinChannelCreator(CHANNEL, alice.pubkey);
  recordChannelAdminListEvent(
    signedList(
      mallory,
      {
        channelId: CHANNEL,
        creator: mallory.pubkey,
        admins: [mallory.pubkey],
      },
      1_699_000_000,
    ),
  );

  assert.equal(getChannelAdminList(CHANNEL), null);

  recordChannelAdminListEvent(genesis);
  assert.equal(getChannelAdminList(CHANNEL).creator, alice.pubkey);
});

test("a pinned creator cannot be moved", () => {
  pinChannelCreator(CHANNEL, alice.pubkey);
  pinChannelCreator(CHANNEL, mallory.pubkey);
  recordChannelAdminListEvent(genesis);
  assert.equal(getChannelAdminList(CHANNEL).creator, alice.pubkey);
});

test("listeners wake on a change and not on a re-delivery", () => {
  let wakes = 0;
  const unsubscribe = subscribeToChannelAdminLists(() => {
    wakes += 1;
  });

  recordChannelAdminListEvent(genesis);
  recordChannelAdminListEvent(genesis);
  assert.equal(wakes, 1);

  unsubscribe();
  recordChannelAdminListEvent(
    signedList(
      alice,
      { channelId: CHANNEL, creator: alice.pubkey, admins: [alice.pubkey] },
      1_700_001_000,
    ),
  );
  assert.equal(wakes, 1);
});
