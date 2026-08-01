import {
  type ChannelAdminList,
  parseChannelAdminListEvent,
  resolveChannelAdminList,
} from "@/shared/api/channelAdminList";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Every admin-list event this client has seen, and the membership state that
 * falls out of them.
 *
 * A cache, not a source of truth: {@link resolveChannelAdminList} re-derives
 * the state from raw events, and this module only decides which events are
 * worth keeping and remembers the answer until they change. Deriving on demand
 * rather than incrementally is deliberate — the fold is order-sensitive, and an
 * incremental version would have to replay history anyway the moment an event
 * arrived out of order, which over a relay is routine.
 *
 * ## Retention
 *
 * One event per `(channel, signer)`, newest wins — the same rule a relay
 * applies to addressable events, applied locally so an out-of-order backfill
 * cannot resurrect a superseded list. Bounded by the number of admins, not by
 * time.
 *
 * ## Pinned creators
 *
 * `resolveChannelAdminList` is trust-on-first-use without a caller-supplied
 * creator, and TOFU is only worth anything if the first answer sticks. So the
 * first time a channel resolves, its creator is pinned, and every later
 * resolution is constrained to that root. A forged genesis backdated below the
 * real one can therefore steal a channel this client has never seen — and
 * nothing else. When the caller knows the creator independently (the channel
 * detail's `createdBy`), {@link pinChannelCreator} closes even that window.
 */

type ChannelRecord = {
  /** Latest event per signer. */
  bySigner: Map<string, RelayEvent>;
  /** Memoized fold, invalidated whenever `bySigner` changes. */
  resolved: ChannelAdminList | null;
  stale: boolean;
};

const channels = new Map<string, ChannelRecord>();
const pinnedCreators = new Map<string, string>();
const listeners = new Set<() => void>();

function record(channelId: string): ChannelRecord {
  let existing = channels.get(channelId);
  if (!existing) {
    existing = { bySigner: new Map(), resolved: null, stale: true };
    channels.set(channelId, existing);
  }
  return existing;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Declare who created a channel, from a source other than the events
 * themselves.
 *
 * Ignored once a creator is pinned: a channel has exactly one root for the
 * lifetime of this client, and letting a later call move it would hand an
 * attacker the same win the pin exists to deny.
 */
export function pinChannelCreator(channelId: string, creator: string): void {
  if (pinnedCreators.has(channelId)) return;
  pinnedCreators.set(channelId, creator.trim().toLowerCase());
  const existing = channels.get(channelId);
  if (existing) existing.stale = true;
  notify();
}

/**
 * Take an inbound event into the store. Returns whether anything changed, so
 * a subscription handler can avoid waking every listener for a re-delivery.
 */
export function recordChannelAdminListEvent(event: RelayEvent): boolean {
  const parsed = parseChannelAdminListEvent(event);
  if (!parsed) return false;

  const target = record(parsed.channelId);
  const previous = target.bySigner.get(parsed.signer);
  if (previous) {
    if (previous.id === event.id) return false;
    if (previous.created_at > event.created_at) return false;
  }

  target.bySigner.set(parsed.signer, event);
  target.stale = true;
  notify();
  return true;
}

/** The validated membership state for a channel, or null when unknown. */
export function getChannelAdminList(
  channelId: string,
): ChannelAdminList | null {
  const target = channels.get(channelId);
  if (!target) return null;
  if (target.stale) {
    target.resolved = resolveChannelAdminList([...target.bySigner.values()], {
      channelId,
      creator: pinnedCreators.get(channelId) ?? null,
    });
    target.stale = false;
    // TOFU: the first accepted root becomes this channel's root forever.
    if (target.resolved && !pinnedCreators.has(channelId)) {
      pinnedCreators.set(channelId, target.resolved.creator);
    }
  }
  return target.resolved;
}

/** The channels this client currently holds a resolved admin list for. */
export function knownAdminListChannelIds(): string[] {
  return [...channels.keys()];
}

/** Observe admin-list changes — held key grants re-check themselves on this. */
export function subscribeToChannelAdminLists(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop everything. For tests, and for switching community. */
export function resetChannelAdminLists(): void {
  channels.clear();
  pinnedCreators.clear();
  notify();
}
