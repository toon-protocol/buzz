import assert from "node:assert/strict";
import test from "node:test";

import { createSeal, createWrap } from "nostr-tools/nip59";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  buildChannelAdminListEvent,
  resolveChannelAdminList,
} from "./channelAdminList.ts";
import {
  channelKeyId,
  formatChannelKey,
  generateChannelKey,
} from "./channelEncryption.ts";
import {
  acceptChannelKeyGrant,
  CHANNEL_KEY_RUMOR_KIND,
  channelKeyWrapFilter,
  unwrapChannelKey,
  wrapChannelKey,
} from "./channelKeyDelivery.ts";

const CHANNEL = "3b0f-private-channel";

function identity() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

const admin = identity();
const member = identity();
const outsider = identity();

/** The admin list a real client would have validated before judging a grant. */
function adminListFor(admins) {
  const event = finalizeEvent(
    {
      ...buildChannelAdminListEvent({
        channelId: CHANNEL,
        creator: admin.pubkey,
        admins,
        keyId: "0123456789abcdef",
      }),
      created_at: 1_700_000_000,
    },
    admin.secretKey,
  );
  return resolveChannelAdminList([event], { channelId: CHANNEL });
}

/** As it arrives from a relay: plain JSON, no memoised verification symbol. */
function fromWire(event) {
  return JSON.parse(JSON.stringify(event));
}

test("a wrapped key round-trips and names the sealing admin as its sender", () => {
  const key = generateChannelKey();
  const wrap = fromWire(
    wrapChannelKey({
      channelId: CHANNEL,
      key,
      epoch: 2,
      recipient: member.pubkey,
      senderSecretKey: admin.secretKey,
    }),
  );

  // The outer wrap leaks only the recipient — not the admin, not the channel.
  assert.equal(wrap.kind, 1059);
  assert.deepEqual(wrap.tags, [["p", member.pubkey]]);
  assert.notEqual(wrap.pubkey, admin.pubkey);
  assert.equal(wrap.content.includes(CHANNEL), false);

  const grant = unwrapChannelKey(wrap, member.secretKey);
  assert.ok(grant);
  assert.equal(grant.channelId, CHANNEL);
  assert.equal(formatChannelKey(grant.key), formatChannelKey(key));
  assert.equal(grant.keyId, channelKeyId(key));
  assert.equal(grant.epoch, 2);
  assert.equal(grant.sender, admin.pubkey);
  assert.equal(grant.wrapId, wrap.id);
});

test("a wrap for someone else does not open", () => {
  const wrap = fromWire(
    wrapChannelKey({
      channelId: CHANNEL,
      key: generateChannelKey(),
      recipient: member.pubkey,
      senderSecretKey: admin.secretKey,
    }),
  );
  assert.equal(unwrapChannelKey(wrap, outsider.secretKey), null);
});

test("an event that is not a gift wrap is not a grant", () => {
  const note = fromWire(
    finalizeEvent(
      { kind: 1, content: "hello", created_at: 1_700_000_000, tags: [] },
      admin.secretKey,
    ),
  );
  assert.equal(unwrapChannelKey(note, member.secretKey), null);
});

test("a rumor claiming an author other than its seal's signer is refused", () => {
  // The forgery buzz#16 has to survive: the outsider builds a rumor that says
  // it came from the admin and seals it with their own key. NIP-59 says the
  // seal's signer is the author, so the mismatch is the tell.
  const rumor = {
    kind: CHANNEL_KEY_RUMOR_KIND,
    content: formatChannelKey(generateChannelKey()),
    created_at: 1_700_000_000,
    pubkey: admin.pubkey,
    id: "0".repeat(64),
    tags: [
      ["h", CHANNEL],
      ["p", member.pubkey],
    ],
  };
  const seal = createSeal(rumor, outsider.secretKey, member.pubkey);
  const wrap = fromWire(createWrap(seal, member.pubkey));

  assert.equal(unwrapChannelKey(wrap, member.secretKey), null);
});

test("a key whose id does not match its own bytes is refused", () => {
  const rumor = {
    kind: CHANNEL_KEY_RUMOR_KIND,
    content: formatChannelKey(generateChannelKey()),
    created_at: 1_700_000_000,
    pubkey: admin.pubkey,
    id: "0".repeat(64),
    tags: [
      ["h", CHANNEL],
      ["key", "ffffffffffffffff", "0"],
      ["p", member.pubkey],
    ],
  };
  const seal = createSeal(rumor, admin.secretKey, member.pubkey);
  const wrap = fromWire(createWrap(seal, member.pubkey));

  assert.equal(unwrapChannelKey(wrap, member.secretKey), null);
});

test("a wrap carrying something other than a key grant is ignored", () => {
  const rumor = {
    kind: 14,
    content: "just a DM",
    created_at: 1_700_000_000,
    pubkey: admin.pubkey,
    id: "0".repeat(64),
    tags: [["p", member.pubkey]],
  };
  const seal = createSeal(rumor, admin.secretKey, member.pubkey);
  const wrap = fromWire(createWrap(seal, member.pubkey));

  assert.equal(unwrapChannelKey(wrap, member.secretKey), null);
});

test("a grant from a current admin is accepted", () => {
  const wrap = fromWire(
    wrapChannelKey({
      channelId: CHANNEL,
      key: generateChannelKey(),
      recipient: member.pubkey,
      senderSecretKey: admin.secretKey,
    }),
  );
  const grant = unwrapChannelKey(wrap, member.secretKey);

  assert.deepEqual(acceptChannelKeyGrant(grant, adminListFor([admin.pubkey])), {
    accepted: true,
  });
});

test("a perfectly valid wrap from a non-admin is rejected", () => {
  const wrap = fromWire(
    wrapChannelKey({
      channelId: CHANNEL,
      key: generateChannelKey(),
      recipient: member.pubkey,
      senderSecretKey: outsider.secretKey,
    }),
  );
  const grant = unwrapChannelKey(wrap, member.secretKey);

  // It unwraps — the crypto is fine. Authority is what it lacks.
  assert.ok(grant);
  assert.equal(grant.sender, outsider.pubkey);
  assert.deepEqual(acceptChannelKeyGrant(grant, adminListFor([admin.pubkey])), {
    accepted: false,
    reason: "sender-not-admin",
  });
});

test("a grant with no admin list to check against is held, not refused", () => {
  const wrap = fromWire(
    wrapChannelKey({
      channelId: CHANNEL,
      key: generateChannelKey(),
      recipient: member.pubkey,
      senderSecretKey: admin.secretKey,
    }),
  );
  const grant = unwrapChannelKey(wrap, member.secretKey);

  assert.deepEqual(acceptChannelKeyGrant(grant, null), {
    accepted: false,
    reason: "no-admin-list",
  });
});

test("the wrap filter asks only for wraps addressed to this client", () => {
  assert.deepEqual(channelKeyWrapFilter(member.pubkey, 5), {
    kinds: [1059],
    "#p": [member.pubkey],
    limit: 5,
  });
});
