import {
  buildChannelAdminListEvent,
  type ChannelAdminList,
  isChannelAdmin,
} from "@/shared/api/channelAdminList";
import {
  getChannelAdminList,
  pinChannelCreator,
  recordChannelAdminListEvent,
} from "@/shared/api/channelAdminListStore";
import { type ChannelKey, channelKeyId } from "@/shared/api/channelEncryption";
import { getChannelKey } from "@/shared/api/channelKeyStore";
import { wrapChannelKeyViaRust } from "@/shared/api/channelKeyDelivery";
import {
  ensureTransportReady,
  publishEvent,
} from "@/shared/api/eventTransport";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The membership write verbs: publish who the admins are, announce which key
 * epoch is current, and hand that key to a new member.
 *
 * Both are ordinary writes and both go through the transport seam
 * (`publishEvent`), which on TOON means both are *paid* — an admin list costs
 * a payment-channel claim exactly as a message does, and a gift wrap costs one
 * per recipient. That is priced in rather than worked around: the alternative
 * is a side channel outside the seam, and a privacy-critical event travelling
 * on a path the transport switch does not cover is how a build ends up
 * publishing keys to the wrong network.
 *
 * These sit upstream of the seam alongside `eventWrites.ts` for the same
 * reason that file gives: event shape is protocol, not transport.
 */

/** Timeout/failure copy for the two writes this module makes. */
const ADMIN_LIST_MESSAGES = {
  timeout: "Timed out publishing the channel's admin list.",
  failure: "Failed to publish the channel's admin list.",
} as const;

const KEY_GRANT_MESSAGES = {
  timeout: "Timed out sending the channel key.",
  failure: "Failed to send the channel key.",
} as const;

/**
 * Sign a channel's admin list and record it locally, without publishing.
 *
 * Recorded from the authoring side rather than waiting for the subscription to
 * echo it back, because the next thing a creator does is add a member and that
 * path needs a resolved admin list to know it is allowed to. Splitting the
 * signature from the send is what lets the caller have that guarantee
 * *immediately* while the network write is still in flight.
 */
async function signChannelAdminList(input: {
  channelId: string;
  creator: string;
  admins?: readonly string[];
  keyId?: string | null;
  epoch?: number;
}): Promise<RelayEvent> {
  const event = await signRelayEvent(buildChannelAdminListEvent(input));
  pinChannelCreator(input.channelId, input.creator);
  recordChannelAdminListEvent(event);
  return event;
}

/** Put a signed admin list on the wire. */
async function publishSignedAdminList(event: RelayEvent): Promise<RelayEvent> {
  await ensureTransportReady();
  return publishEvent(
    event,
    ADMIN_LIST_MESSAGES.timeout,
    ADMIN_LIST_MESSAGES.failure,
  );
}

/** A signed admin list, and the paid write carrying it to everyone else. */
export type AdminListPublication = {
  event: RelayEvent;
  /** Resolves when the admin list reaches the network; rejects if it cannot. */
  published: Promise<RelayEvent>;
};

/**
 * Give a freshly created private channel its membership authority.
 *
 * Publishes the admin list naming the creator as its first admin, and nothing
 * else. In particular it does **not** mint a channel key, which is a
 * deliberate line: #12 established that "encryption is switched on by the
 * presence of a key and nothing else", and auto-keying every private channel
 * would quietly move that switch to the visibility flag.
 *
 * That is not a stylistic preference. Keying a channel is the act that makes
 * its whole history unreadable to anyone who does not hold the bytes — every
 * member whose wrap has not landed, every reader on a client that predates
 * this feature. Deciding that on the user's behalf, silently, from a checkbox
 * they ticked to mean "not listed publicly", is a bigger claim than buzz#16
 * asks for: the issue asks for the admin list at creation, and says nothing
 * about minting a key. So keying stays an act the user takes knowingly, in
 * channel settings — and `announceChannelKey` is what carries it into the
 * admin list when they do.
 *
 * The publish is handed back rather than awaited. Everything the creator's own
 * client needs — the pinned creator, a resolvable admin list — is true the
 * moment this resolves; the send is what the *other* members need, and on TOON
 * it is a paid write over a network that may be slow. Blocking the
 * create-channel dialog on it buys nothing and loses the channel's first
 * seconds.
 *
 * Only private channels. A public channel on TOON is public in the strongest
 * sense — the relay serves its plaintext to anyone — so an admin list would
 * claim an authority over it that means nothing.
 */
export async function provisionPrivateChannel(channel: {
  id: string;
  visibility: string;
}): Promise<AdminListPublication | null> {
  if (channel.visibility !== "private") return null;

  const identity = await getIdentity();
  const existingKey = getChannelKey(channel.id);

  const event = await signChannelAdminList({
    channelId: channel.id,
    creator: identity.pubkey,
    admins: [identity.pubkey],
    keyId: existingKey ? channelKeyId(existingKey) : null,
    epoch: 0,
  });

  return { event, published: publishSignedAdminList(event) };
}

/**
 * Record a channel's key in its admin list, so members can tell which epoch
 * they should be holding.
 *
 * Called when an admin generates or pastes a key in channel settings — the
 * moment a channel actually becomes encrypted. Without it the admin list would
 * advertise no key while the channel had one, and an arriving member would
 * have nothing to check a gift-wrapped grant's epoch against.
 *
 * Refuses when this client is not an admin of a validated list, including the
 * case where there is no list at all. Publishing an admin list for someone
 * else's channel would fork its chain and, on a client that has not yet seen
 * the real one, pin the wrong creator — a self-inflicted denial of the very
 * channel the user was trying to join.
 */
export async function announceChannelKey(
  channelId: string,
  key: ChannelKey,
): Promise<AdminListPublication | null> {
  const adminList = getChannelAdminList(channelId);
  if (!adminList) return null;

  const identity = await getIdentity();
  if (!isChannelAdmin(adminList, identity.pubkey)) return null;

  const keyId = channelKeyId(key);
  if (adminList.keyId === keyId) return null;

  const event = await signChannelAdminList({
    channelId,
    creator: adminList.creator,
    admins: adminList.admins,
    keyId,
    epoch: adminList.epoch,
  });

  return { event, published: publishSignedAdminList(event) };
}

/** What happened when an admin tried to hand out the key. */
export type ChannelKeyGrantOutcome = {
  delivered: string[];
  skipped: Array<{ pubkey: string; reason: string }>;
};

function skipAll(
  pubkeys: readonly string[],
  reason: string,
): ChannelKeyGrantOutcome {
  return {
    delivered: [],
    skipped: pubkeys.map((pubkey) => ({ pubkey, reason })),
  };
}

/**
 * Gift-wrap this channel's key to each new member.
 *
 * Refuses rather than improvises when it cannot do the job properly:
 *
 * - **No key held** — this client is not a member either; there is nothing to
 *   send. (An unencrypted channel lands here, which is correct: adding someone
 *   to a public channel involves no key.)
 * - **Not an admin** — the recipients' clients would reject the wrap anyway
 *   (that is buzz#16's third requirement), so sending it would only burn a
 *   paid write and teach the user that key delivery is unreliable.
 * - **No admin list** — the channel predates this feature or its list has not
 *   arrived. Sending a key nobody can validate is worse than not sending it:
 *   the recipient holds unusable bytes and has no way to know why.
 *
 * One wrap per recipient, published independently, and one failure does not
 * cancel the rest — a member who did not get their key can be re-added, but a
 * member whose delivery was abandoned because someone else's failed cannot
 * tell that is what happened.
 */
export async function grantChannelKeyToMembers(
  channelId: string,
  pubkeys: readonly string[],
): Promise<ChannelKeyGrantOutcome> {
  if (pubkeys.length === 0) return { delivered: [], skipped: [] };

  const key = getChannelKey(channelId);
  if (!key) return skipAll(pubkeys, "this client holds no key for the channel");

  const adminList: ChannelAdminList | null = getChannelAdminList(channelId);
  if (!adminList) {
    return skipAll(pubkeys, "the channel has no validated admin list yet");
  }

  const identity = await getIdentity();
  if (!isChannelAdmin(adminList, identity.pubkey)) {
    return skipAll(pubkeys, "this client is not an admin of the channel");
  }

  await ensureTransportReady();

  const outcome: ChannelKeyGrantOutcome = { delivered: [], skipped: [] };
  for (const pubkey of pubkeys) {
    if (pubkey === identity.pubkey) continue;
    try {
      const wrap = await wrapChannelKeyViaRust({
        channelId,
        key,
        epoch: adminList.epoch,
        recipient: pubkey,
      });
      await publishEvent(
        wrap,
        KEY_GRANT_MESSAGES.timeout,
        KEY_GRANT_MESSAGES.failure,
      );
      outcome.delivered.push(pubkey);
    } catch (error) {
      outcome.skipped.push({
        pubkey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}
