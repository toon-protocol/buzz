import {
  buildChannelAdminListEvent,
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
import { wrapChannelKeyViaRust } from "@/shared/api/channelKeyDelivery";
import { adoptChannelKey, getChannelKey } from "@/shared/api/channelKeyStore";
import {
  ensureTransportReady,
  publishEvent,
} from "@/shared/api/eventTransport";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Key rotation when a member is removed (buzz#18).
 *
 * Removing someone from an encrypted channel is not a roster edit. Membership
 * IS key possession (ADR 0001), so a removal that leaves the key alone removes
 * nothing: the relay serves the channel's ciphertext to everyone, and the
 * person just removed still holds the bytes that open it. Rotation is the
 * actual removal.
 *
 * ## What rotation does not do
 *
 * It does not take back history. The removed member keeps the key they were
 * given and everything sealed under it stays readable to them forever —
 * ADR 0001 calls this Slack-export semantics and accepts it. Nothing else is
 * achievable against an open relay: they could have copied every ciphertext
 * and the key before anyone clicked remove. Rotation protects the future.
 *
 * ## The publish order, and why it is this one
 *
 * ```
 * 1. gift-wrap the new key to every REMAINING member      (N paid writes)
 * 2. publish the admin list: epoch + 1, new keyId, member gone   (1 write)
 * 3. only now switch this client's sending key — unless this client is the
 *    member being removed, which is a rotation it must not be able to read
 * ```
 *
 * Wraps first. The wraps are validated by the recipient against the admin list
 * *they* currently hold, which before step 2 is the pre-rotation list — and
 * the sender is an admin in it, so they are accepted. Publishing the list
 * first would create a window in which the list names an epoch whose key
 * nobody has been sent: every survivor would see a channel whose current key
 * they do not hold, which is indistinguishable from having been removed.
 *
 * The list second. It is the single event that tells the channel a new epoch
 * exists, and by the time it lands the key it names has already been sent to
 * everyone entitled to it. That is what "atomic from clients' perspective"
 * means here: there is no observable state in which the channel has moved to
 * an epoch its members cannot reach.
 *
 * Sending switches last, and never before the list is signed. Receivers are
 * indifferent to the order — every sealed message names its key id and a
 * survivor's ring opens both epochs — so the only ordering that can hurt is
 * sealing under a key the rest of the channel has not been told about. Doing
 * it last means there is no moment where a message is written under an
 * unannounced key, and none at all where anything is written in the clear:
 * the old key stays the sending key right up to the swap.
 *
 * The failure modes fall out of the same order. Wraps that fail leave the
 * channel on its old epoch and the removed member still readable — the caller
 * is told which recipients were missed and can rotate again. A list that fails
 * to publish leaves this client sending under a key the others hold but have
 * not promoted: they keep sending under the old one, this client reads both,
 * they read both. Degraded, visible, and recoverable — never a plaintext
 * message and never a member locked out of their own channel.
 *
 * ## Ports
 *
 * Signing, publishing, identity and key generation are injected. The defaults
 * are the real ones — publishing is `eventTransport.publishEvent`, so on TOON
 * every wrap and the list are paid writes through the seam like any other
 * event — and the seam exists so a test can watch the order these are called
 * in, which is the property this module is mostly making claims about.
 */

/** Why a rotation did not happen. Every one of them is an ordinary state. */
export type ChannelKeyRotationRefusal =
  /** No key here, so no key to rotate: removal is only a roster change. */
  | "channel-not-encrypted"
  /** The channel predates the admin list, or its list has not arrived. */
  | "no-admin-list"
  /** Only an admin may name a new epoch; anyone else's list would be refused. */
  | "not-an-admin";

/** What happened when an admin removed someone from an encrypted channel. */
export type ChannelKeyRotationOutcome =
  | { rotated: false; reason: ChannelKeyRotationRefusal }
  | {
      rotated: true;
      /** The new epoch's public key id — on the list and on every message. */
      keyId: string;
      epoch: number;
      /** Members the new key reached. */
      delivered: string[];
      /** Members it did not, and why. They stay on the old epoch. */
      skipped: Array<{ pubkey: string; reason: string }>;
      /** The signed admin list, already recorded locally. */
      adminList: RelayEvent;
      /** Resolves when that list reaches the network; rejects if it cannot. */
      published: Promise<RelayEvent>;
    };

/** The outside world, injectable so the publish *order* can be asserted. */
export type ChannelKeyRotationPorts = {
  identity: () => Promise<{ pubkey: string }>;
  wrap: (input: {
    channelId: string;
    key: ChannelKey;
    epoch?: number;
    recipient: string;
  }) => Promise<RelayEvent>;
  sign: (template: {
    kind: number;
    content: string;
    tags: string[][];
  }) => Promise<RelayEvent>;
  publish: (
    event: RelayEvent,
    timeoutMessage: string,
    sendErrorMessage: string,
  ) => Promise<RelayEvent>;
  ready: () => Promise<void>;
  freshKey: () => ChannelKey;
};

const KEY_ROTATION_MESSAGES = {
  timeout: "Timed out sending the rotated channel key.",
  failure: "Failed to send the rotated channel key.",
} as const;

const ADMIN_LIST_MESSAGES = {
  timeout: "Timed out publishing the channel's admin list.",
  failure: "Failed to publish the channel's admin list.",
} as const;

/** The real implementations. Publishing goes through the transport seam. */
export const liveRotationPorts: ChannelKeyRotationPorts = {
  identity: getIdentity,
  wrap: wrapChannelKeyViaRust,
  sign: signRelayEvent,
  publish: publishEvent,
  ready: ensureTransportReady,
  freshKey: generateChannelKey,
};

const PUBKEY_RE = /^[0-9a-f]{64}$/;

function normalizePubkeys(values: readonly string[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    const pubkey = value.trim().toLowerCase();
    if (!PUBKEY_RE.test(pubkey) || seen.includes(pubkey)) continue;
    seen.push(pubkey);
  }
  return seen;
}

/**
 * Rotate `channelId`'s key so `removed` can no longer read it.
 *
 * `remaining` is the roster after the removal — whoever should hold the new
 * key. It is filtered against `removed` and against this client rather than
 * trusted, because the caller reads it from a members query that may have been
 * cached before the removal landed, and a stale roster that re-wraps the key
 * to the person being removed would undo the entire operation silently.
 *
 * Rotating *yourself* out is this same call with this client's own pubkey in
 * `removed` — what the voluntary-leave trigger does (buzz#42). It differs in
 * exactly one place, the end: the new key is never taken into this client's
 * ring, so a leaver finishes the rotation on the epoch they were already in.
 * They keep the history they could already read — ADR 0001's Slack-export
 * semantics do not change because the departure was their own idea — and hold
 * nothing that opens what the channel says after them. A rotation that handed
 * the leaver the new epoch would deny nobody anything: every remaining member
 * could already read the channel, so the only access it can withdraw is the
 * departing member's.
 *
 * Removing an admin is the same call: the new list simply omits them, so they
 * lose both the ability to read the channel and the authority to hand its key
 * out, in one signed event. The channel's *creator* is the exception — the
 * chain is rooted in them and `buildChannelAdminListEvent` will not produce a
 * list that drops them — so removing the creator rotates the key (they are cut
 * off from the content like anyone else) while leaving their name on the list.
 * Re-rooting a channel is a different feature.
 */
export async function rotateChannelKeyForRemoval(
  input: {
    channelId: string;
    removed: readonly string[];
    remaining: readonly string[];
  },
  ports: ChannelKeyRotationPorts = liveRotationPorts,
): Promise<ChannelKeyRotationOutcome> {
  const { channelId } = input;

  // Cheapest first, and the common case: most channels have no key, so a
  // removal in one costs nothing — not an identity read, not an IPC hop.
  if (getChannelKey(channelId) === null) {
    return { rotated: false, reason: "channel-not-encrypted" };
  }

  const adminList = getChannelAdminList(channelId);
  if (!adminList) return { rotated: false, reason: "no-admin-list" };

  const identity = await ports.identity();
  if (!isChannelAdmin(adminList, identity.pubkey)) {
    return { rotated: false, reason: "not-an-admin" };
  }

  const removed = normalizePubkeys(input.removed);
  // Normalised the way the rosters are, because two decisions compare against
  // it: whether to wrap the key to ourselves (never), and whether we are the
  // member being removed (then we do not keep the key at all). A differently
  // cased pubkey must not be able to turn either of those into a "no".
  const self = identity.pubkey.trim().toLowerCase();
  const recipients = normalizePubkeys(input.remaining).filter(
    (pubkey) => !removed.includes(pubkey) && pubkey !== self,
  );

  const key = ports.freshKey();
  const keyId = channelKeyId(key);
  const epoch = adminList.epoch + 1;

  await ports.ready();

  // Step 1: the survivors, before anything announces the epoch they are for.
  // One failure does not cancel the rest — a member who missed their wrap is
  // one re-run away from having it, but a member whose delivery was abandoned
  // because someone else's failed has no way to tell that is what happened.
  const delivered: string[] = [];
  const skipped: Array<{ pubkey: string; reason: string }> = [];
  for (const pubkey of recipients) {
    try {
      await ports.publish(
        await ports.wrap({ channelId, key, epoch, recipient: pubkey }),
        KEY_ROTATION_MESSAGES.timeout,
        KEY_ROTATION_MESSAGES.failure,
      );
      delivered.push(pubkey);
    } catch (error) {
      skipped.push({
        pubkey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Step 2: the epoch itself. Signed and recorded before it is sent, so this
  // client's own view of the channel has already moved — the same split
  // `channelMembership.signChannelAdminList` makes, for the same reason.
  const adminListEvent = await ports.sign(
    buildChannelAdminListEvent({
      channelId,
      creator: adminList.creator,
      admins: adminList.admins.filter((pubkey) => !removed.includes(pubkey)),
      keyId,
      epoch,
    }),
  );
  pinChannelCreator(channelId, adminList.creator);
  recordChannelAdminListEvent(adminListEvent);
  const published = ports.publish(
    adminListEvent,
    ADMIN_LIST_MESSAGES.timeout,
    ADMIN_LIST_MESSAGES.failure,
  );

  // Step 3: switch, unless this client rotated itself out — then there is
  // nothing to switch to. The new epoch belongs to the members who stayed, and
  // a leaver who kept it would read everything the channel said after they
  // walked out, which is the one access this rotation exists to withdraw.
  //
  // Never adopted rather than adopted and then forgotten: a key that is never
  // written to the ring cannot be left in it by a failure between the two
  // steps, and nothing persists it in the meantime.
  //
  // Otherwise straight to the front of the ring rather than through
  // `reconcileChannelKeyEpochs`, because the rule that gate enforces — send
  // only under an epoch a validated admin list names — is already satisfied:
  // this client signed that list and recorded it on the line above. Making the
  // switch depend on re-folding our own event would add a way for a rotation
  // to half-happen, and no safety.
  if (!removed.includes(self)) {
    adoptChannelKey(channelId, key, { makeCurrent: true });
  }

  return {
    rotated: true,
    keyId,
    epoch,
    delivered,
    skipped,
    adminList: adminListEvent,
    published,
  };
}
