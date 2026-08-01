import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  buildChannelAdminListEvent,
  CHANNEL_ADMIN_LIST_KIND,
  channelAdminListFilter,
  isChannelAdmin,
  parseChannelAdminListEvent,
  resolveChannelAdminList,
} from "./channelAdminList.ts";

const CHANNEL = "9f2c1d54-channel";

function identity() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

const alice = identity();
const bob = identity();
const mallory = identity();

/**
 * An event as it comes off the relay: plain JSON and nothing else.
 *
 * `nostr-tools` memoises `verifyEvent` on a symbol property of the object it
 * checked, and object spread copies own symbol keys — so a tampered `{...event}`
 * arrives pre-marked "verified" and proves nothing. Every attacker-built event
 * in this file is round-tripped through JSON first, which is also exactly what
 * the transport does to it.
 */
function fromWire(event) {
  return JSON.parse(JSON.stringify(event));
}

/** Sign an admin list the way `publishChannelAdminList` does. */
function signAdminList(signer, input, createdAt) {
  const template = buildChannelAdminListEvent(input);
  return finalizeEvent(
    { ...template, created_at: createdAt },
    signer.secretKey,
  );
}

const genesis = signAdminList(
  alice,
  {
    channelId: CHANNEL,
    creator: alice.pubkey,
    admins: [alice.pubkey],
    keyId: "aaaaaaaaaaaaaaaa",
    epoch: 0,
  },
  1_700_000_000,
);

test("the built event is addressable by channel id and names the creator first", () => {
  const template = buildChannelAdminListEvent({
    channelId: CHANNEL,
    creator: bob.pubkey,
    admins: [alice.pubkey, bob.pubkey],
    keyId: "bbbbbbbbbbbbbbbb",
    epoch: 3,
  });

  assert.equal(template.kind, CHANNEL_ADMIN_LIST_KIND);
  assert.ok(
    CHANNEL_ADMIN_LIST_KIND >= 30000 && CHANNEL_ADMIN_LIST_KIND <= 39999,
    "the kind must be parameterized-replaceable",
  );
  assert.equal(template.content, "");
  assert.deepEqual(template.tags, [
    ["d", CHANNEL],
    ["creator", bob.pubkey],
    ["p", bob.pubkey, "admin"],
    ["p", alice.pubkey, "admin"],
    ["key", "bbbbbbbbbbbbbbbb", "3"],
  ]);
});

test("a list with no key yet carries no key tag", () => {
  const template = buildChannelAdminListEvent({
    channelId: CHANNEL,
    creator: alice.pubkey,
  });
  assert.equal(
    template.tags.some((tag) => tag[0] === "key"),
    false,
  );
});

test("parsing reads the roster, the key epoch, and the signer", () => {
  const parsed = parseChannelAdminListEvent(genesis);
  assert.ok(parsed);
  assert.equal(parsed.channelId, CHANNEL);
  assert.equal(parsed.creator, alice.pubkey);
  assert.equal(parsed.signer, alice.pubkey);
  assert.deepEqual(parsed.admins, [alice.pubkey]);
  assert.equal(parsed.keyId, "aaaaaaaaaaaaaaaa");
  assert.equal(parsed.epoch, 0);
});

test("a list that drops its own creator is self-contradictory and unparseable", () => {
  const orphaned = finalizeEvent(
    {
      kind: CHANNEL_ADMIN_LIST_KIND,
      content: "",
      created_at: 1_700_000_100,
      tags: [
        ["d", CHANNEL],
        ["creator", alice.pubkey],
        ["p", bob.pubkey, "admin"],
      ],
    },
    alice.secretKey,
  );
  assert.equal(parseChannelAdminListEvent(orphaned), null);
});

test("the genesis event roots the chain and its creator is the first admin", () => {
  const resolved = resolveChannelAdminList([genesis], { channelId: CHANNEL });
  assert.ok(resolved);
  assert.equal(resolved.creator, alice.pubkey);
  assert.deepEqual(resolved.admins, [alice.pubkey]);
  assert.equal(isChannelAdmin(resolved, alice.pubkey), true);
  assert.equal(isChannelAdmin(resolved, bob.pubkey), false);
});

test("an admin may promote another admin", () => {
  const promotion = signAdminList(
    alice,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey, bob.pubkey],
      keyId: "aaaaaaaaaaaaaaaa",
      epoch: 0,
    },
    1_700_000_500,
  );

  const resolved = resolveChannelAdminList([genesis, promotion], {
    channelId: CHANNEL,
  });
  assert.deepEqual(resolved.admins, [alice.pubkey, bob.pubkey]);
  assert.equal(isChannelAdmin(resolved, bob.pubkey), true);
});

test("a non-admin cannot write themselves onto the list", () => {
  const coup = signAdminList(
    mallory,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey, mallory.pubkey],
      keyId: "aaaaaaaaaaaaaaaa",
      epoch: 0,
    },
    1_700_001_000,
  );

  const resolved = resolveChannelAdminList([genesis, coup], {
    channelId: CHANNEL,
  });
  assert.deepEqual(resolved.admins, [alice.pubkey]);
  assert.equal(isChannelAdmin(resolved, mallory.pubkey), false);
});

test("a forged signature is discarded before the chain ever sees it", () => {
  // Alice's genesis, re-labelled as Mallory's. The pubkey field is just a
  // string until it is checked against the signature.
  const forged = fromWire({
    ...genesis,
    pubkey: mallory.pubkey,
    tags: [
      ["d", CHANNEL],
      ["creator", mallory.pubkey],
      ["p", mallory.pubkey, "admin"],
    ],
  });
  assert.equal(parseChannelAdminListEvent(forged).signer, mallory.pubkey);
  const resolved = resolveChannelAdminList([forged], { channelId: CHANNEL });
  assert.equal(resolved, null);
});

test("tampering with an admin's own list invalidates it", () => {
  const tampered = fromWire({
    ...genesis,
    tags: [...genesis.tags, ["p", mallory.pubkey, "admin"]],
  });
  const resolved = resolveChannelAdminList([tampered], { channelId: CHANNEL });
  assert.equal(resolved, null);
});

test("a genesis from someone other than the known creator is refused", () => {
  const impostor = signAdminList(
    mallory,
    {
      channelId: CHANNEL,
      creator: mallory.pubkey,
      admins: [mallory.pubkey],
    },
    1_699_000_000,
  );

  // With no expected creator the earlier event wins — trust on first use.
  const tofu = resolveChannelAdminList([genesis, impostor], {
    channelId: CHANNEL,
  });
  assert.equal(tofu.creator, mallory.pubkey);

  // Told who created the channel, the client is not fooled by a backdate.
  const pinned = resolveChannelAdminList([genesis, impostor], {
    channelId: CHANNEL,
    creator: alice.pubkey,
  });
  assert.equal(pinned.creator, alice.pubkey);
  assert.equal(isChannelAdmin(pinned, mallory.pubkey), false);
});

test("a demoted admin's later events stop being accepted", () => {
  const promotion = signAdminList(
    alice,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey, bob.pubkey],
    },
    1_700_000_500,
  );
  const demotion = signAdminList(
    alice,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey],
    },
    1_700_000_600,
  );
  const bobFightsBack = signAdminList(
    bob,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey, bob.pubkey],
    },
    1_700_000_700,
  );

  const resolved = resolveChannelAdminList(
    // Deliberately shuffled: the fold sorts, so relay ordering cannot matter.
    [bobFightsBack, genesis, demotion, promotion],
    { channelId: CHANNEL },
  );
  assert.deepEqual(resolved.admins, [alice.pubkey]);
});

test("the key epoch never moves backwards (buzz#18's replay guard)", () => {
  const rotated = signAdminList(
    alice,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey],
      keyId: "cccccccccccccccc",
      epoch: 1,
    },
    1_700_000_500,
  );
  const replayedOldEpoch = signAdminList(
    alice,
    {
      channelId: CHANNEL,
      creator: alice.pubkey,
      admins: [alice.pubkey],
      keyId: "aaaaaaaaaaaaaaaa",
      epoch: 0,
    },
    1_700_000_900,
  );

  const resolved = resolveChannelAdminList(
    [genesis, rotated, replayedOldEpoch],
    { channelId: CHANNEL },
  );
  assert.equal(resolved.epoch, 1);
  assert.equal(resolved.keyId, "cccccccccccccccc");
});

test("events for another channel are ignored", () => {
  const elsewhere = signAdminList(
    mallory,
    {
      channelId: "some-other-channel",
      creator: mallory.pubkey,
      admins: [mallory.pubkey],
    },
    1_700_000_001,
  );
  const resolved = resolveChannelAdminList([genesis, elsewhere], {
    channelId: CHANNEL,
  });
  assert.deepEqual(resolved.admins, [alice.pubkey]);
});

test("the subscription filter asks for admin lists and nothing else", () => {
  assert.deepEqual(channelAdminListFilter(12), {
    kinds: [CHANNEL_ADMIN_LIST_KIND],
    limit: 12,
  });
});
