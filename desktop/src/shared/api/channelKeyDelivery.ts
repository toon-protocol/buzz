import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { wrapEvent } from "nostr-tools/nip59";
import { verifyEvent } from "nostr-tools/pure";

import {
  type ChannelAdminList,
  isChannelAdmin,
} from "@/shared/api/channelAdminList";
import {
  type ChannelKey,
  channelKeyId,
  formatChannelKey,
  parseChannelKey,
} from "@/shared/api/channelEncryption";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { sealGiftWrap, unsealGiftWrap } from "@/shared/api/tauriGiftWrap";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_CHANNEL_KEY_DELIVERY,
  KIND_GIFT_WRAP,
  KIND_SEAL,
} from "@/shared/constants/kinds";

/**
 * Getting a channel key to a new member, over a relay that reads it.
 *
 * #12 shipped the key and left its delivery to a human copying hex between two
 * clients. This is the replacement: NIP-59 gift wrap, which is the same
 * envelope NIP-17 DMs already travel in and which the relay already accepts
 * (`NOSTR.md`: "NIP-17 DMs (gift wrap) — kind:1059 accepted").
 *
 * ## Why gift wrap rather than a plain NIP-44 DM
 *
 * A NIP-44-encrypted event still names its author and recipient in the clear.
 * Over an open relay that publishes the social graph of a private channel:
 * every add-member is a visible edge from an admin to a new member. A gift
 * wrap is signed by a throwaway key and carries only `["p", recipient]`, so an
 * observer learns that *someone* sent *this pubkey* something. That is the
 * membership metadata this fork can actually afford to leak.
 *
 * ## The three layers, and which one is the sender
 *
 * ```
 * kind:1059 wrap    signed by an ephemeral key    ["p", recipient]
 *   kind:13 seal    signed by the REAL sender     no tags
 *     kind:44300 rumor  unsigned, id only          ["h", channelId], ["key", keyId, epoch]
 * ```
 *
 * The seal's signer is the author. That is the load-bearing fact for buzz#16's
 * third requirement: a key is accepted only from a current admin, and "who
 * sent this" means the seal's `pubkey`, never the wrap's (ephemeral, proves
 * nothing) and never the rumor's (unsigned, therefore claimable by anyone who
 * can build a seal — which is why {@link unwrapChannelKey} insists the two
 * match).
 *
 * ## Why the unwrap is not `nip59.unwrapEvent`
 *
 * `nostr-tools`' `unwrapEvent` returns the rumor and discards the seal, so the
 * caller never sees the one field authority depends on. We therefore peel the
 * two NIP-44 layers ourselves — still with `nostr-tools/nip44`, no hand-rolled
 * crypto, just one fewer thing thrown away. Wrapping uses `nip59.wrapEvent`
 * unchanged.
 *
 * ## Which pair of these functions the app actually calls
 *
 * The `ViaRust` pair ({@link wrapChannelKeyViaRust},
 * {@link unwrapChannelKeyViaRust}): since buzz#43 both NIP-44 layers are done
 * by the `seal_gift_wrap`/`unseal_gift_wrap` commands against the identity
 * `AppState` already holds, so no channel-key wrap costs the renderer a copy
 * of the secret key. The secret-key-taking {@link wrapChannelKey} and
 * {@link unwrapChannelKey} above them are the reference implementation the
 * unit suite runs — real crypto, no Tauri host to call into.
 */

/** The rumor kind carried inside the wrap. */
export const CHANNEL_KEY_RUMOR_KIND = KIND_CHANNEL_KEY_DELIVERY;

/** A channel key that arrived from someone, before anyone has vouched for them. */
export type ChannelKeyGrant = {
  channelId: string;
  key: ChannelKey;
  /** #12's public key id, recomputed from the bytes rather than trusted. */
  keyId: string;
  /** Rotation epoch this key belongs to (buzz#18). */
  epoch: number;
  /** The seal's signer: who actually sent this. */
  sender: string;
  /** When the sender sealed it. */
  sentAt: number;
  /** The wrap it came out of, for logging and de-duplication. */
  wrapId: string;
};

/**
 * Why a grant was refused. Surfaced so a refusal is never silent.
 *
 * Only these, because the malformed and not-for-us cases never get this far:
 * {@link unwrapChannelKey} returns null for them, which on an open relay is
 * the overwhelmingly common outcome and not worth reporting. These are the
 * cases where a real key for a real channel is being turned away.
 */
export type ChannelKeyRejection =
  | "sender-not-admin"
  | "no-admin-list"
  | "stale-epoch";

/**
 * The rumor an admin seals: one key, one channel, one recipient.
 *
 * The key travels as hex because that is the form `parseChannelKey` already
 * validates and the form a human sees in channel settings — one encoding for
 * the key everywhere, so there is no second parser to get wrong.
 */
export function buildChannelKeyRumor(input: {
  channelId: string;
  key: ChannelKey;
  epoch?: number;
  recipient: string;
}): { kind: number; content: string; tags: string[][] } {
  return {
    kind: CHANNEL_KEY_RUMOR_KIND,
    content: formatChannelKey(input.key),
    tags: [
      ["h", input.channelId],
      ["key", channelKeyId(input.key), String(input.epoch ?? 0)],
      ["p", input.recipient],
    ],
  };
}

/**
 * Wrap a channel key for one member. Returns the kind:1059 event to publish.
 *
 * `senderSecretKey` is the admin's own key: the seal has to be signed by the
 * identity the recipient will check against the admin list, so this cannot be
 * delegated to an ephemeral key the way the outer wrap is.
 *
 * No production caller since buzz#43 — the app seals through
 * {@link wrapChannelKeyViaRust}, which never names a secret key. This stays as
 * the reference implementation the unit suite builds its fixtures with, and is
 * not a path to wire an identity key back into the renderer through.
 */
export function wrapChannelKey(input: {
  channelId: string;
  key: ChannelKey;
  epoch?: number;
  recipient: string;
  senderSecretKey: Uint8Array;
}): RelayEvent {
  const rumor = buildChannelKeyRumor({
    channelId: input.channelId,
    key: input.key,
    epoch: input.epoch,
    recipient: input.recipient,
  });
  return wrapEvent(
    rumor,
    input.senderSecretKey,
    input.recipient,
  ) as unknown as RelayEvent;
}

type SealedLayer = {
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
};

function openLayer(
  payload: string,
  secretKey: Uint8Array,
  counterparty: string,
): unknown {
  return JSON.parse(
    nip44Decrypt(payload, getConversationKey(secretKey, counterparty)),
  );
}

function asLayer(value: unknown): SealedLayer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== "number" ||
    typeof record.pubkey !== "string" ||
    typeof record.content !== "string" ||
    typeof record.created_at !== "number"
  ) {
    return null;
  }
  return record as unknown as SealedLayer;
}

function tagValue(tags: unknown, name: string): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return undefined;
}

function tagAt(tags: unknown, name: string, index: number): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name) {
      const value = tag[index];
      return typeof value === "string" ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Turn an already-authenticated rumor (sender verified, layers peeled) into a
 * {@link ChannelKeyGrant}, or `null` if it is not a well-formed one.
 *
 * The one place both unwrap paths agree on what a valid key grant looks like:
 * the pure path ({@link unwrapChannelKey}, real crypto, no Tauri host — what
 * the unit test suite exercises) and the Rust-backed path
 * ({@link unwrapChannelKeyViaRust}, buzz#43's seal/unseal commands). Both have
 * already established *who* sent the rumor (the seal's signer) before calling
 * this; what is left is deciding whether its `kind`/`content`/`tags` actually
 * describe a channel key.
 */
function parseChannelKeyRumor(input: {
  /** Untyped: the pure path reads these off a freshly parsed JSON rumor. */
  kind: unknown;
  content: unknown;
  tags: unknown;
  sender: string;
  sentAt: number;
  wrapId: string;
}): ChannelKeyGrant | null {
  if (input.kind !== CHANNEL_KEY_RUMOR_KIND) return null;

  const channelId = tagValue(input.tags, "h");
  const key = parseChannelKey(
    typeof input.content === "string" ? input.content : null,
  );
  if (!channelId || !key) return null;

  const declaredKeyId = tagValue(input.tags, "key");
  const actualKeyId = channelKeyId(key);
  if (declaredKeyId && declaredKeyId !== actualKeyId) return null;

  const epoch = Number.parseInt(tagAt(input.tags, "key", 2) ?? "0", 10);

  return {
    channelId,
    key,
    keyId: actualKeyId,
    epoch: Number.isFinite(epoch) && epoch >= 0 ? epoch : 0,
    sender: input.sender,
    sentAt: input.sentAt,
    wrapId: input.wrapId,
  };
}

/**
 * Open a gift wrap addressed to us and read the channel key out of it.
 *
 * Null on anything that is not a well-formed key grant for this recipient —
 * including a wrap for someone else, which on an open relay is most of them.
 * Failure to unwrap is the ordinary case, not an error condition, exactly as
 * failure to decrypt a channel message is in #12.
 *
 * What it insists on, and why each one matters:
 * - the wrap is kind:1059 and the seal inside is kind:13 — layer confusion is
 *   how a signed-by-the-victim event gets replayed as a seal;
 * - the seal's signature verifies — an unverified `pubkey` is an
 *   attacker-supplied string, and it is the string authority is decided from;
 * - the rumor's `pubkey` equals the seal's — NIP-59 requires it, and without
 *   the check anyone who can build a seal can *claim* to be relaying an
 *   admin's rumor;
 * - the key's own `channelKeyId` matches the `key` tag — the tag is what a
 *   client uses to match messages to keys, so a mislabelled one would quietly
 *   lock a channel it just unlocked.
 *
 * It deliberately does NOT decide whether to accept the key: that needs the
 * admin list, and lives in {@link acceptChannelKeyGrant}.
 *
 * No production caller since buzz#43 — the inbox opens wraps through
 * {@link unwrapChannelKeyViaRust}. This stays as the reference implementation
 * the unit suite checks that path against, and is not a path to wire an
 * identity key back into the renderer through.
 */
export function unwrapChannelKey(
  wrap: RelayEvent,
  recipientSecretKey: Uint8Array,
): ChannelKeyGrant | null {
  if (wrap.kind !== KIND_GIFT_WRAP) return null;

  try {
    const seal = asLayer(
      openLayer(wrap.content, recipientSecretKey, wrap.pubkey),
    );
    if (!seal || seal.kind !== KIND_SEAL) return null;
    if (!verifyEvent(seal as unknown as Parameters<typeof verifyEvent>[0])) {
      return null;
    }

    const rumor = openLayer(seal.content, recipientSecretKey, seal.pubkey);
    if (typeof rumor !== "object" || rumor === null) return null;
    const record = rumor as Record<string, unknown>;
    // NIP-59: the seal's signer is the author, so a rumor claiming a different
    // one is a relayed forgery attempt.
    if (record.pubkey !== seal.pubkey) return null;

    return parseChannelKeyRumor({
      kind: record.kind,
      content: record.content,
      tags: record.tags,
      sender: seal.pubkey,
      sentAt: seal.created_at,
      wrapId: wrap.id,
    });
  } catch {
    // A wrap for another recipient fails the MAC here. That is the common path.
    return null;
  }
}

/**
 * {@link wrapChannelKey}, via the Rust seal command (buzz#43) instead of a
 * secret key handed to the renderer. Seals under this identity — whichever
 * one `AppState` currently holds — so there is no `senderSecretKey` to pass;
 * the recipient and channel/key/epoch are all this needs to say.
 */
export async function wrapChannelKeyViaRust(input: {
  channelId: string;
  key: ChannelKey;
  epoch?: number;
  recipient: string;
}): Promise<RelayEvent> {
  const rumor = buildChannelKeyRumor(input);
  return sealGiftWrap({
    recipient: input.recipient,
    kind: rumor.kind,
    content: rumor.content,
    tags: rumor.tags,
  });
}

/**
 * {@link unwrapChannelKey}, via the Rust unseal command (buzz#43) instead of
 * a secret key handed to the renderer. Same contract — `null` for a wrap that
 * is not for us or not a well-formed grant — because the sender authenticity
 * check (rumor author === seal signer) already happened inside
 * `unseal_gift_wrap` (`nostr` crate's `nip59::extract_rumor`), so there is
 * nothing left to verify here beyond what {@link parseChannelKeyRumor} does
 * for both paths.
 */
export async function unwrapChannelKeyViaRust(
  wrap: RelayEvent,
): Promise<ChannelKeyGrant | null> {
  if (wrap.kind !== KIND_GIFT_WRAP) return null;

  const unsealed = await unsealGiftWrap(wrap);
  if (!unsealed) return null;

  return parseChannelKeyRumor({
    kind: unsealed.kind,
    content: unsealed.content,
    tags: unsealed.tags,
    sender: unsealed.sender,
    sentAt: unsealed.createdAt,
    wrapId: wrap.id,
  });
}

/**
 * The admin check: buzz#16's third requirement, in one function.
 *
 * A key is only a key. What makes it *this channel's* key is that a current
 * admin said so — so an unwrapped grant is worthless until its sender is
 * matched against the validated admin list, and a grant that arrives before
 * that list does is held, not accepted (`no-admin-list`).
 *
 * The epoch check is buzz#18's half of this, present early because it costs
 * one comparison and is unpleasant to retrofit: a grant older than the epoch
 * the admin list advertises is a superseded key, and replaying one after a
 * rotation is precisely how a removed member would try to keep reading. It
 * cannot fire today — every grant is minted at the list's current epoch — and
 * it is tested so that stays true once rotation exists.
 *
 * Note what is deliberately not checked: whether the recipient is on a member
 * list. There is no member list. Possession of the key IS membership (ADR
 * 0001) — an admin handing over the key is the act of adding someone.
 */
export function acceptChannelKeyGrant(
  grant: ChannelKeyGrant,
  adminList: ChannelAdminList | null,
): { accepted: true } | { accepted: false; reason: ChannelKeyRejection } {
  if (adminList === null) return { accepted: false, reason: "no-admin-list" };
  if (!isChannelAdmin(adminList, grant.sender)) {
    return { accepted: false, reason: "sender-not-admin" };
  }
  if (grant.epoch < adminList.epoch) {
    return { accepted: false, reason: "stale-epoch" };
  }
  return { accepted: true };
}

/** Gift wraps addressed to `pubkey`. The only read this feature needs. */
export function channelKeyWrapFilter(
  pubkey: string,
  limit = 200,
): RelaySubscriptionFilter {
  return { kinds: [KIND_GIFT_WRAP], "#p": [pubkey], limit };
}
