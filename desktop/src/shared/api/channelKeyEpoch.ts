import {
  getChannelAdminList,
  subscribeToChannelAdminLists,
} from "@/shared/api/channelAdminListStore";
import {
  encryptedChannelIds,
  getChannelKey,
  promoteChannelKey,
} from "@/shared/api/channelKeyStore";

/**
 * Which epoch a channel *sends* under, decided by its validated admin list.
 *
 * Rotation (buzz#18) publishes in a fixed order: gift wraps to the survivors
 * first, then the kind:39100 admin list naming the new `keyId` and `epoch + 1`.
 * That order is what makes the change atomic from a client's point of view —
 * nobody is asked to seal under a key some members have not been sent — but it
 * means the two halves land separately and in either order. This module is the
 * join.
 *
 * The rule is one line: **a held key becomes the sending key when the
 * channel's validated admin list names it.** Everything else follows.
 *
 * - A survivor who has the wrap but not the list holds the new key for reading
 *   and keeps sending under the old one. Both are readable by everyone who
 *   matters, so the channel does not split.
 * - A survivor who has the list but not the wrap cannot promote a key it does
 *   not hold; the wrap lands, the inbox adopts it, and this runs again.
 * - A member removed by the rotation gets neither. Their ring still opens the
 *   history sealed under the epoch they were in, and nothing promotes them
 *   into one they were not.
 *
 * There is deliberately no demotion. `resolveChannelAdminList` already refuses
 * an epoch that moves backwards, so a replayed pre-rotation list cannot name
 * an older `keyId` here — and if the fold ever let one through, sending under
 * a key a removed member holds is the failure this feature exists to prevent.
 * Promote-only means the worst a bad list achieves is no change at all.
 */

/** Channels whose sending key moved. Empty is the overwhelmingly common case. */
export function reconcileChannelKeyEpochs(
  channelIds: readonly string[] = encryptedChannelIds(),
): string[] {
  const promoted: string[] = [];
  for (const channelId of channelIds) {
    const keyId = getChannelAdminList(channelId)?.keyId;
    if (!keyId) continue;
    // Cheap reject before the ring scan: the announced epoch is usually the
    // one already at the front, and this runs on every admin-list delivery.
    if (getChannelKey(channelId) === null) continue;
    if (promoteChannelKey(channelId, keyId)) promoted.push(channelId);
  }
  return promoted;
}

/**
 * Keep the sending key aligned with the admin list for as long as the app runs.
 *
 * Subscribed to the admin-list store rather than polled: a rotation's list is
 * an ordinary inbound event, and the store already wakes its listeners for
 * exactly the change that matters. The other direction — a wrap arriving after
 * its list — is handled at the adoption site in `channelKeyInbox.ts`, because
 * that is where a new key enters the ring at all.
 *
 * Returns its unsubscribe, for tests and for sign-out.
 */
export function installChannelKeyEpochSync(): () => void {
  reconcileChannelKeyEpochs();
  return subscribeToChannelAdminLists(() => {
    reconcileChannelKeyEpochs();
  });
}
