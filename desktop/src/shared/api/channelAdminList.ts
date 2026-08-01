import { verifyEvent } from "nostr-tools/pure";

import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_CHANNEL_ADMIN_LIST } from "@/shared/constants/kinds";

/**
 * Membership authority for an encrypted channel, as a signed event.
 *
 * ## Why not NIP-29's 39001
 *
 * Buzz already has an admin list on the wire: NIP-29 kind:39001, `d` = channel
 * id, `p` tags with `owner`/`admin` roles. It is unusable here for exactly one
 * reason, and it is the reason this fork exists — those events are *relay*
 * signed. `NOSTR.md` says so, and ADR 0001 says the relay is never the
 * membership authority: on TOON the relay is a pay-to-write dumb pipe that
 * serves every reader and enforces nothing. Rendering membership from a
 * relay-signed event would put the relay back in the trust path with a
 * cryptographic-looking veneer on top.
 *
 * So this is a new kind, `39100`, carrying the same *shape* (addressable,
 * `d` = channel id, `p` tags with roles) signed by a member instead. The
 * number sits just past NIP-29's relay-generated 39000–39009 block so it still
 * reads as channel state; Buzz already extends this range with 39005/39006.
 *
 * ## Addressable, and why that is not enough
 *
 * 39100 is in the parameterized-replaceable range (30000–39999), so a relay
 * keeps the newest event per `(kind, pubkey, d)`. That gives "an admin's
 * latest list wins" for free — but the tuple includes `pubkey`, so N admins
 * produce N surviving events for one channel and the relay has no opinion
 * about which is real. Worse, anyone at all can publish a 39100 with any
 * `d` tag: replaceability is storage semantics, not authority.
 *
 * Authority comes from {@link resolveChannelAdminList}, which folds every
 * candidate in `created_at` order and accepts a state transition only when its
 * signer was an admin in the state *before* it. The chain is rooted at a
 * genesis event that names itself: `creator` tag == its own signer. That fold
 * is the whole security argument — the relay may drop, reorder, or inject
 * events and the worst it achieves is a stale list, never a forged one.
 *
 * ## Rotation (buzz#18)
 *
 * The `key` tag carries the channel's current key epoch:
 *
 * ```
 * ["key", "<keyId>", "<epoch>"]
 * ```
 *
 * `keyId` is #12's `channelKeyId` — a public, non-reversible name for the key
 * that also appears on every encrypted message. Rotation is then a normal
 * admin-list update with a new `keyId` and `epoch + 1`, plus a gift wrap of
 * the new key to each remaining member. The fold already refuses an epoch that
 * moves backwards, so a replayed pre-rotation list cannot un-rotate a channel.
 */

/** The channel-metadata / admin-list kind. See the module doc. */
export const CHANNEL_ADMIN_LIST_KIND = KIND_CHANNEL_ADMIN_LIST;

/** Role labels a `p` tag may carry to count as an admin. */
const ADMIN_ROLES = new Set(["admin", "owner"]);

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/** One parsed 39100 event, before it has been judged against the chain. */
export type ChannelAdminListEvent = {
  channelId: string;
  /** The `creator` tag: which genesis this event claims to descend from. */
  creator: string;
  admins: string[];
  /** Current key epoch's public key id (#12), or null before a key exists. */
  keyId: string | null;
  epoch: number;
  /** Who signed it. Authority is decided from this, never from the tags. */
  signer: string;
  createdAt: number;
  event: RelayEvent;
};

/** The accepted membership state for a channel. */
export type ChannelAdminList = {
  channelId: string;
  creator: string;
  admins: string[];
  keyId: string | null;
  epoch: number;
  /** `created_at` of the newest accepted event. */
  updatedAt: number;
  /** The newest accepted event, kept so callers can re-verify or re-publish. */
  event: RelayEvent;
};

function normalizePubkey(value: string | undefined): string | null {
  const lowered = value?.trim().toLowerCase() ?? "";
  return PUBKEY_RE.test(lowered) ? lowered : null;
}

/**
 * Admins in canonical order: creator first, then the rest in the order given,
 * deduplicated. The creator leads because they are the chain's root and a
 * reader scanning the tag list should not have to cross-reference `creator`.
 */
function canonicalAdmins(creator: string, admins: readonly string[]): string[] {
  const ordered = [creator];
  for (const candidate of admins) {
    const pubkey = normalizePubkey(candidate);
    if (pubkey && !ordered.includes(pubkey)) ordered.push(pubkey);
  }
  return ordered;
}

/**
 * The unsigned template for a channel's admin list, ready for
 * `signRelayEvent`.
 *
 * Content is empty. Nothing here is secret — an admin list is public metadata
 * about a channel whose *contents* are the private part — and an empty content
 * field means the event is fully described by tags a reader can index.
 */
export function buildChannelAdminListEvent(input: {
  channelId: string;
  creator: string;
  admins?: readonly string[];
  keyId?: string | null;
  epoch?: number;
}): { kind: number; content: string; tags: string[][] } {
  const creator = normalizePubkey(input.creator);
  if (!creator) throw new Error("An admin list needs a valid creator pubkey.");
  if (!input.channelId.trim()) {
    throw new Error("An admin list needs a channel id.");
  }

  const admins = canonicalAdmins(creator, input.admins ?? []);
  const tags: string[][] = [
    ["d", input.channelId],
    ["creator", creator],
    ...admins.map((pubkey) => ["p", pubkey, "admin"]),
  ];
  if (input.keyId) {
    tags.push(["key", input.keyId, String(input.epoch ?? 0)]);
  }

  return { kind: CHANNEL_ADMIN_LIST_KIND, content: "", tags };
}

function firstTagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && tag[1]) return tag[1];
  }
  return undefined;
}

/**
 * Structural read of a 39100 event. Null when it is not one, or is
 * self-inconsistent.
 *
 * Says nothing about authority — an attacker can produce a perfectly
 * well-formed admin list naming themselves. {@link resolveChannelAdminList}
 * is what decides whether to believe it.
 */
export function parseChannelAdminListEvent(
  event: RelayEvent,
): ChannelAdminListEvent | null {
  if (event.kind !== CHANNEL_ADMIN_LIST_KIND) return null;

  const channelId = firstTagValue(event.tags, "d");
  const creator = normalizePubkey(firstTagValue(event.tags, "creator"));
  const signer = normalizePubkey(event.pubkey);
  if (!channelId || !creator || !signer) return null;

  const admins: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "p" || !ADMIN_ROLES.has(tag[2] ?? "")) continue;
    const pubkey = normalizePubkey(tag[1]);
    if (pubkey && !admins.includes(pubkey)) admins.push(pubkey);
  }

  // A creator who is not an admin of their own channel is a contradiction, not
  // a demotion: the chain is rooted in them, so a list that drops them has cut
  // the branch it is standing on.
  if (!admins.includes(creator)) return null;

  const keyTag = event.tags.find((tag) => tag[0] === "key" && tag[1]);
  const epoch = Number.parseInt(keyTag?.[2] ?? "0", 10);

  return {
    channelId,
    creator,
    admins: canonicalAdmins(creator, admins),
    keyId: keyTag?.[1] ?? null,
    epoch: Number.isFinite(epoch) && epoch >= 0 ? epoch : 0,
    signer,
    createdAt: event.created_at,
    event,
  };
}

/** Deterministic order: oldest first, event id breaking `created_at` ties. */
function chainOrder(
  left: ChannelAdminListEvent,
  right: ChannelAdminListEvent,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.event.id.localeCompare(right.event.id);
}

function toState(parsed: ChannelAdminListEvent): ChannelAdminList {
  return {
    channelId: parsed.channelId,
    creator: parsed.creator,
    admins: parsed.admins,
    keyId: parsed.keyId,
    epoch: parsed.epoch,
    updatedAt: parsed.createdAt,
    event: parsed.event,
  };
}

/**
 * The channel's membership state, or null when no valid chain exists.
 *
 * Every candidate's signature is checked before anything else: these events
 * arrive from a relay that is explicitly not trusted, so an unverified `pubkey`
 * field is just an attacker-supplied string. Then:
 *
 * 1. **Genesis** is the earliest event that names itself — `creator` tag equals
 *    its own signer. When the caller knows who created the channel it passes
 *    `creator` and only that pubkey can root the chain.
 * 2. **Every later event** is accepted only if its signer is an admin in the
 *    state that precedes it, it descends from the same genesis creator, and its
 *    key epoch does not move backwards.
 *
 * Folding in time order is what makes removal stick: an admin demoted at T
 * cannot have their T+1 events accepted, because by then they are not in the
 * state being checked against.
 *
 * Without a caller-supplied `creator` this is trust-on-first-use, and the
 * honest statement of its limit is that a forged genesis with an earlier
 * `created_at` wins a channel the client has never seen before. That is why
 * `channelAdminListStore` pins the creator the first time a channel resolves
 * and passes it back in forever after.
 */
export function resolveChannelAdminList(
  events: readonly RelayEvent[],
  options: { channelId: string; creator?: string | null },
): ChannelAdminList | null {
  const expectedCreator = normalizePubkey(options.creator ?? undefined);

  const candidates: ChannelAdminListEvent[] = [];
  for (const event of events) {
    const parsed = parseChannelAdminListEvent(event);
    if (!parsed || parsed.channelId !== options.channelId) continue;
    if (!verifyEvent(event)) continue;
    candidates.push(parsed);
  }
  candidates.sort(chainOrder);

  let state: ChannelAdminList | null = null;
  for (const candidate of candidates) {
    if (state === null) {
      const rootsItself = candidate.creator === candidate.signer;
      const isExpected =
        expectedCreator === null || candidate.signer === expectedCreator;
      if (rootsItself && isExpected) state = toState(candidate);
      continue;
    }

    if (candidate.creator !== state.creator) continue;
    if (!state.admins.includes(candidate.signer)) continue;
    if (candidate.epoch < state.epoch) continue;
    state = toState(candidate);
  }

  return state;
}

/** Whether `pubkey` may distribute this channel's key or change its admins. */
export function isChannelAdmin(
  list: ChannelAdminList | null,
  pubkey: string | null | undefined,
): boolean {
  const candidate = normalizePubkey(pubkey ?? undefined);
  if (!list || !candidate) return false;
  return list.admins.includes(candidate);
}

/**
 * The subscription filter that keeps admin lists current.
 *
 * Unscoped by channel on purpose: a client must be able to validate a key it
 * was just gift-wrapped for a channel it has never seen, and it cannot ask for
 * that channel's list by id before it knows the id. These events are small,
 * public, and one per channel per admin.
 */
export function channelAdminListFilter(limit = 500): RelaySubscriptionFilter {
  return { kinds: [CHANNEL_ADMIN_LIST_KIND], limit };
}
