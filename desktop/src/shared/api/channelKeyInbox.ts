import { channelAdminListFilter } from "@/shared/api/channelAdminList";
import {
  getChannelAdminList,
  recordChannelAdminListEvent,
  subscribeToChannelAdminLists,
} from "@/shared/api/channelAdminListStore";
import { channelKeyId } from "@/shared/api/channelEncryption";
import {
  acceptChannelKeyGrant,
  type ChannelKeyGrant,
  channelKeyWrapFilter,
  unwrapChannelKey,
} from "@/shared/api/channelKeyDelivery";
import { getChannelKey, setChannelKey } from "@/shared/api/channelKeyStore";
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
 * `setChannelKey` — #12's store — and nothing else. Its listeners re-render
 * channel settings, and because every encrypted message carries the `keyId`
 * that sealed it, history that was rendering as locked placeholders opens on
 * the next read with no re-fetch and no special case here. The whole unlock
 * path this module is responsible for is that one line.
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
};

export type ChannelKeyInboxOptions = {
  /** This client's pubkey — the `#p` the wraps are addressed to. */
  pubkey: string;
  /** This client's secret key, for the two NIP-44 unwrap layers. */
  secretKey: Uint8Array;
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
  const existing = getChannelKey(grant.channelId);
  if (existing && channelKeyId(existing) === grant.keyId) {
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

  setChannelKey(grant.channelId, grant.key);
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

  const drainHeld = () => {
    for (const [channelId, grant] of [...held]) {
      if (applyGrant(grant, report)) held.delete(channelId);
    }
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

      const grant = unwrapChannelKey(event, options.secretKey);
      // Not for us, or not a key grant. On an open relay that is most wraps.
      if (!grant) return;

      if (!applyGrant(grant, report)) held.set(grant.channelId, grant);
    },
  );

  // The admin-list backlog may have landed while wraps were still arriving.
  drainHeld();

  return {
    async stop() {
      unsubscribeStore();
      held.clear();
      await Promise.allSettled([disposeAdminLists(), disposeWraps()]);
    },
    heldChannelIds() {
      return [...held.keys()];
    },
  };
}
