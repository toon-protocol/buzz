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
import {
  type ChannelKey,
  channelKeyId,
  generateChannelKey,
} from "@/shared/api/channelEncryption";
import { getChannelKey, setChannelKey } from "@/shared/api/channelKeyStore";
import { wrapChannelKey } from "@/shared/api/channelKeyDelivery";
import {
  ensureTransportReady,
  publishEvent,
} from "@/shared/api/eventTransport";
import { getIdentitySecretKey } from "@/shared/api/identitySecretKey";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The membership write verbs: publish who the admins are, and hand the key to
 * a new member.
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
 * Sign and publish a channel's admin list, and record it locally.
 *
 * Recorded into the store from the publishing side too, rather than waiting
 * for the subscription to echo it back: the next thing a creator does is add a
 * member, and that path needs a resolved admin list to know it is allowed to.
 */
export async function publishChannelAdminList(input: {
  channelId: string;
  creator: string;
  admins?: readonly string[];
  keyId?: string | null;
  epoch?: number;
}): Promise<RelayEvent> {
  await ensureTransportReady();

  const template = buildChannelAdminListEvent(input);
  const event = await signRelayEvent(template);

  pinChannelCreator(input.channelId, input.creator);
  recordChannelAdminListEvent(event);

  return publishEvent(
    event,
    ADMIN_LIST_MESSAGES.timeout,
    ADMIN_LIST_MESSAGES.failure,
  );
}

/**
 * Bring a freshly created private channel under key management.
 *
 * Three things happen and they have to happen in this order: a key exists, it
 * is stored locally, and only then is an admin list published naming its
 * `keyId`. An admin list that advertises a key the creator has not saved would
 * point every member at bytes nobody holds.
 *
 * A channel that already has a key keeps it — re-running this after a partial
 * failure republishes the list rather than rotating the channel out from under
 * anyone who already has the old key.
 *
 * Only private channels. A public channel on TOON is public in the strongest
 * sense — the relay serves its plaintext to anyone — so giving it an admin
 * list and a key would claim a privacy it does not have.
 */
export async function provisionPrivateChannel(channel: {
  id: string;
  visibility: string;
}): Promise<ChannelKey | null> {
  if (channel.visibility !== "private") return null;

  const identity = await getIdentity();
  const key = getChannelKey(channel.id) ?? generateChannelKey();
  setChannelKey(channel.id, key);

  await publishChannelAdminList({
    channelId: channel.id,
    creator: identity.pubkey,
    admins: [identity.pubkey],
    keyId: channelKeyId(key),
    epoch: 0,
  });

  return key;
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
  const secretKey = await getIdentitySecretKey();

  const outcome: ChannelKeyGrantOutcome = { delivered: [], skipped: [] };
  for (const pubkey of pubkeys) {
    if (pubkey === identity.pubkey) continue;
    try {
      const wrap = wrapChannelKey({
        channelId,
        key,
        epoch: adminList.epoch,
        recipient: pubkey,
        senderSecretKey: secretKey,
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
