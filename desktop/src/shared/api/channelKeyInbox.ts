import { channelAdminListFilter } from "@/shared/api/channelAdminList";
import {
  getChannelAdminList,
  recordChannelAdminListEvent,
  subscribeToChannelAdminLists,
} from "@/shared/api/channelAdminListStore";
import {
  acceptChannelKeyGrant,
  type ChannelKeyGrant,
  channelKeyWrapFilter,
  unwrapChannelKey,
} from "@/shared/api/channelKeyDelivery";
import { reconcileChannelKeyEpochs } from "@/shared/api/channelKeyEpoch";
import { adoptChannelKey, findChannelKey } from "@/shared/api/channelKeyStore";
import { subscribeLiveEvents } from "@/shared/api/eventTransport";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The receiving half of key delivery: watch for gift wraps addressed to this
 * client, and unlock the channels an admin has let it into.
 *
 * ## Two subscriptions, not one
 *
 * Wraps say who sent them; only the admin list says whether that mattered. The
 * inbox therefore reads both, and neither can be made to arrive first. A relay
 * may hand over the wrap and the list in either order, and on TOON they may
 * not even come from the same REQ backlog.
 *
 * So a grant that arrives before its channel's admin list is *held*, not
 * dropped, and every admin-list change re-examines what is held. Dropping it
 * would produce the worst failure this feature can have: a member who was
 * legitimately added, whose client silently decided they were not, and whose
 * channel stays locked with nothing in the UI to say why. Holding costs one
 * small object per unresolved channel.
 *
 * ## Unlocking is one call
 *
 * `adoptChannelKey` — #12's store, widened to a ring by #18 — and nothing
 * else. Its listeners re-render channel settings, and because every encrypted
 * message carries the `keyId` that sealed it, history that was rendering as
 * locked placeholders opens on the next read with no re-fetch and no special
 * case here. The whole unlock path this module is responsible for is that one
 * line.
 *
 * What the ring changes is *which* key the adopted one becomes. A first key is
 * unambiguously the channel's key. A rotation key arrives while the channel is
 * still agreeing on the previous epoch — the wraps are published before the
 * admin list that names them (buzz#18's ordering) — so it is taken in for
 * reading and only starts sealing outbound messages once the validated list
 * says so. {@link reconcileChannelKeyEpochs} is that promotion, called here
 * for the wrap-after-list order and driven by the admin-list subscription for
 * the list-after-wrap one.
 */

/** How a subscription is opened. Swapped for a fake in tests. */
export type InboxSubscribe = (
  filter: RelaySubscriptionFilter,
  onEvent: (event: RelayEvent) => void,
) => Promise<() => Promise<void>>;

/** What the inbox did with one wrap. Reported so a refusal is never silent. */
export type ChannelKeyInboxEvent =
  | { type: "unlocked"; channelId: string; keyId: string; sender: string }
  | { type: "held"; channelId: string; sender: string }
  | { type: "rejected"; channelId: string; sender: string; reason: string }
  | { type: "already-held"; channelId: string; keyId: string };

export type ChannelKeyInbox = {
  /** Stop both subscriptions and forget anything held. */
  stop(): Promise<void>;
  /** Grants waiting on an admin list, keyed by channel. Test/diagnostic view. */
  heldChannelIds(): string[];
  /** Resolves when every wrap delivered so far has been dealt with. */
  settled(): Promise<void>;
};

export type ChannelKeyInboxOptions = {
  /** This client's pubkey — the `#p` the wraps are addressed to. */
  pubkey: string;
  /**
   * This client's secret key, for the two NIP-44 unwrap layers.
   *
   * A function, and called only when a wrap addressed to this client actually
   * turns up — most sessions never receive one, and reading the key out of the
   * keychain for a thing that may never happen is both a needless IPC round
   * trip and a needless copy of the key in the renderer's heap. Resolved once
   * and reused for the life of the inbox: the alternative is a keychain read
   * per inbound wrap.
   */
  getSecretKey: () => Promise<Uint8Array>;
  subscribe?: InboxSubscribe;
  /** Told about every decision. Defaults to a console log. */
  onEvent?: (event: ChannelKeyInboxEvent) => void;
};

function logInboxEvent(event: ChannelKeyInboxEvent): void {
  switch (event.type) {
    case "unlocked":
      console.info(
        `[channel-keys] ${event.channelId} unlocked by ${event.sender} (key ${event.keyId})`,
      );
      return;
    case "held":
      console.info(
        `[channel-keys] holding a key for ${event.channelId} until its admin list arrives`,
      );
      return;
    case "rejected":
      console.warn(
        `[channel-keys] refused a key for ${event.channelId} from ${event.sender}: ${event.reason}`,
      );
      return;
    case "already-held":
      return;
  }
}

/**
 * Take one unwrapped grant as far as it can go right now.
 *
 * Returns true when the grant is settled — accepted or refused on its merits —
 * and false when it is only unanswerable yet and should be held.
 */
function applyGrant(
  grant: ChannelKeyGrant,
  report: (event: ChannelKeyInboxEvent) => void,
): boolean {
  // Any epoch, not just the current one. A relay re-delivering a pre-rotation
  // wrap must not send this back round the admin check, and must never be
  // able to move a superseded key back to the front of the ring.
  if (findChannelKey(grant.channelId, grant.keyId)) {
    report({
      type: "already-held",
      channelId: grant.channelId,
      keyId: grant.keyId,
    });
    return true;
  }

  const verdict = acceptChannelKeyGrant(
    grant,
    getChannelAdminList(grant.channelId),
  );
  if (!verdict.accepted) {
    if (verdict.reason === "no-admin-list") {
      report({
        type: "held",
        channelId: grant.channelId,
        sender: grant.sender,
      });
      return false;
    }
    report({
      type: "rejected",
      channelId: grant.channelId,
      sender: grant.sender,
      reason: verdict.reason,
    });
    return true;
  }

  // Into the ring, not necessarily to the front of it. A first key unlocks the
  // channel outright; a rotation key is held for reading until the validated
  // admin list names its epoch, so no member starts sealing under a key the
  // rest of the channel has not agreed on yet (buzz#18).
  adoptChannelKey(grant.channelId, grant.key);
  reconcileChannelKeyEpochs([grant.channelId]);
  report({
    type: "unlocked",
    channelId: grant.channelId,
    keyId: grant.keyId,
    sender: grant.sender,
  });
  return true;
}

/**
 * Start watching. Resolves once both subscriptions are caught up, so a caller
 * that awaits it knows the backlog has been considered.
 */
export async function startChannelKeyInbox(
  options: ChannelKeyInboxOptions,
): Promise<ChannelKeyInbox> {
  const subscribe = options.subscribe ?? subscribeLiveEvents;
  const report = options.onEvent ?? logInboxEvent;

  /** Newest unsettled grant per channel. Older ones are superseded, not queued. */
  const held = new Map<string, ChannelKeyGrant>();
  /** Wrap ids already unwrapped — relays re-deliver, and unwrapping is ECDH. */
  const seenWraps = new Set<string>();
  /** Resolved on the first wrap that reaches us, then reused. */
  let secretKey: Promise<Uint8Array> | null = null;
  /**
   * Serialises wrap handling. Unwrapping became async the moment the key was
   * fetched lazily, and two wraps for one channel resolving out of order would
   * decide "held or applied" against a store snapshot that had already moved.
   */
  let queue: Promise<void> = Promise.resolve();

  const drainHeld = () => {
    for (const [channelId, grant] of [...held]) {
      if (applyGrant(grant, report)) held.delete(channelId);
    }
  };

  const handleWrap = async (event: RelayEvent) => {
    secretKey ??= options.getSecretKey();
    const grant = unwrapChannelKey(event, await secretKey);
    // Not for us, or not a key grant. On an open relay that is most wraps.
    if (!grant) return;
    if (!applyGrant(grant, report)) held.set(grant.channelId, grant);
  };

  const unsubscribeStore = subscribeToChannelAdminLists(drainHeld);

  const disposeAdminLists = await subscribe(
    channelAdminListFilter(),
    (event) => {
      recordChannelAdminListEvent(event);
    },
  );

  const disposeWraps = await subscribe(
    channelKeyWrapFilter(options.pubkey),
    (event) => {
      if (seenWraps.has(event.id)) return;
      seenWraps.add(event.id);
      queue = queue.then(() =>
        handleWrap(event).catch((error) => {
          // An unreadable keychain must not kill the subscription: the next
          // wrap, or the next launch, may find it unlocked.
          console.warn("[channel-keys] could not open a gift wrap", error);
        }),
      );
    },
  );

  // The admin-list backlog may have landed while wraps were still arriving.
  drainHeld();
  await queue;

  return {
    async stop() {
      unsubscribeStore();
      held.clear();
      await Promise.allSettled([disposeAdminLists(), disposeWraps()]);
    },
    heldChannelIds() {
      return [...held.keys()];
    },
    settled() {
      return queue;
    },
  };
}
