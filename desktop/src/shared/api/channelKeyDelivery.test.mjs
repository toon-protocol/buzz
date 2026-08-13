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
  unwrapChannelKeyViaRust,
  wrapChannelKey,
  wrapChannelKeyViaRust,
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
function adminListFor(admins, epoch = 0) {
  const event = finalizeEvent(
    {
      ...buildChannelAdminListEvent({
        channelId: CHANNEL,
        creator: admin.pubkey,
        admins,
        keyId: "0123456789abcdef",
        epoch,
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

test("a key from before the channel's current epoch is refused (buzz#18)", () => {
  const wrap = fromWire(
    wrapChannelKey({
      channelId: CHANNEL,
      key: generateChannelKey(),
      epoch: 0,
      recipient: member.pubkey,
      senderSecretKey: admin.secretKey,
    }),
  );
  const grant = unwrapChannelKey(wrap, member.secretKey);

  // Same admin, valid signature — but the channel has rotated past this key.
  assert.deepEqual(
    acceptChannelKeyGrant(grant, adminListFor([admin.pubkey], 1)),
    { accepted: false, reason: "stale-epoch" },
  );
  // At the epoch it was minted for, the same grant is fine.
  assert.deepEqual(
    acceptChannelKeyGrant(grant, adminListFor([admin.pubkey], 0)),
    { accepted: true },
  );
});

test("the wrap filter asks only for wraps addressed to this client", () => {
  assert.deepEqual(channelKeyWrapFilter(member.pubkey, 5), {
    kinds: [1059],
    "#p": [member.pubkey],
    limit: 5,
  });
});

// --- the Rust-backed path (buzz#43) ---
//
// What these pin down is the seam, not the crypto: the arguments
// `seal_gift_wrap` is handed, and which field of `unseal_gift_wrap`'s answer
// becomes which field of the grant. The two NIP-44 layers themselves are the
// Rust unit tests' job (`desktop/src-tauri/src/commands/gift_wrap.rs`), and
// there is no Tauri host here to run them.

/** Runs `body` with `window.__TAURI_INTERNALS__.invoke` answered by `handler`. */
function withMockedInvoke(handler, body) {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return handler(command, args);
      },
    },
  };
  return Promise.resolve(body(calls)).finally(() => {
    globalThis.window = previousWindow;
  });
}

test("sealing through Rust hands it the rumor an admin would have signed", async () => {
  const key = generateChannelKey();
  const sealed = { id: "wrap-id", kind: 1059, tags: [["p", member.pubkey]] };

  await withMockedInvoke(
    () => JSON.stringify(sealed),
    async (calls) => {
      const wrap = await wrapChannelKeyViaRust({
        channelId: CHANNEL,
        key,
        epoch: 3,
        recipient: member.pubkey,
      });

      assert.deepEqual(wrap, sealed);
      assert.deepEqual(calls, [
        {
          command: "seal_gift_wrap",
          args: {
            recipient: member.pubkey,
            kind: CHANNEL_KEY_RUMOR_KIND,
            content: formatChannelKey(key),
            tags: [
              ["h", CHANNEL],
              ["key", channelKeyId(key), "3"],
              ["p", member.pubkey],
            ],
          },
        },
      ]);
    },
  );
});

test("a wrap Rust opens becomes the grant the pure path would have produced", async () => {
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

  await withMockedInvoke(
    () => ({
      sender: admin.pubkey,
      kind: CHANNEL_KEY_RUMOR_KIND,
      content: formatChannelKey(key),
      tags: [
        ["h", CHANNEL],
        ["key", channelKeyId(key), "2"],
        ["p", member.pubkey],
      ],
      createdAt: 1_700_000_000,
    }),
    async (calls) => {
      const grant = await unwrapChannelKeyViaRust(wrap);
      const pure = unwrapChannelKey(wrap, member.secretKey);

      // Everything the admin check and the key ring read is identical to what
      // the pure path produces. `sentAt` is the one field that is not: Rust
      // reports the rumor's own timestamp, the pure path the seal's — and a
      // seal's is deliberately tweaked into the past (NIP-59). Nothing but
      // diagnostics reads it.
      assert.deepEqual({ ...grant, sentAt: 0 }, { ...pure, sentAt: 0 });
      assert.equal(grant.sentAt, 1_700_000_000);
      assert.equal(grant.wrapId, wrap.id);
      // The whole wrap goes over, so Rust checks the layers against the event
      // as the relay sent it rather than a reassembled copy.
      assert.equal(calls[0].command, "unseal_gift_wrap");
      assert.deepEqual(JSON.parse(calls[0].args.wrapJson), wrap);
    },
  );
});

test("a wrap Rust cannot open is not a grant", async () => {
  await withMockedInvoke(
    () => null,
    async () =>
      assert.equal(
        await unwrapChannelKeyViaRust({ id: "wrap-id", kind: 1059 }),
        null,
      ),
  );
});

test("an event that is not a gift wrap never reaches Rust", async () => {
  await withMockedInvoke(
    () => assert.fail("no command should have been invoked"),
    async (calls) => {
      assert.equal(
        await unwrapChannelKeyViaRust({ id: "note-id", kind: 1 }),
        null,
      );
      assert.deepEqual(calls, []);
    },
  );
});

test("a key id that does not match its own bytes is refused on the Rust path too", async () => {
  await withMockedInvoke(
    () => ({
      sender: admin.pubkey,
      kind: CHANNEL_KEY_RUMOR_KIND,
      content: formatChannelKey(generateChannelKey()),
      tags: [
        ["h", CHANNEL],
        ["key", "ffffffffffffffff", "0"],
        ["p", member.pubkey],
      ],
      createdAt: 1_700_000_000,
    }),
    async () =>
      assert.equal(
        await unwrapChannelKeyViaRust({ id: "wrap-id", kind: 1059 }),
        null,
      ),
  );
});
