import { isThreadReply } from "@/features/messages/lib/threading";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { CHANNEL_TIMELINE_CONTENT_KINDS } from "@/shared/constants/kinds";
import {
  compareRelayOrder,
  type ChannelWindowCursor,
  type ChannelWindowPage,
  type ChannelWindowRow,
} from "./channelWindowStore";

/**
 * Client-side counterpart to `channelWindowResponse.parseChannelWindowResponse`
 * for the TOON transport.
 *
 * `parseChannelWindowResponse` trusts a relay-signed `39006` bounds event to
 * say where the next page starts and whether one exists — buzz-relay computes
 * both server-side. The TOON relay is a plain NIP-01 event store with no such
 * event, so this module derives the same two answers from the raw page
 * itself: `until`/`limit` build the request, and how full the raw response
 * came back is the only signal available for `hasMore`.
 *
 * The split mirrors `eventTransport.ts`'s seam: `channelWindow.ts` (the
 * transport-agnostic facade "history enters the app" through) picks this path
 * or the relay's bounds-based one, and everything downstream — the window
 * store, the scroll-back trigger, the renderer — takes a `ChannelWindowPage`
 * and does not know which one produced it.
 *
 * Known limitation: NIP-01 has no id-keyset filter, only `until` (a
 * timestamp). When a single `created_at` second holds more events than fit
 * in one page's `limit`, the client cannot ask a plain relay for "the rest of
 * this second" the way the relay-mode bounds path can — it can only ask for
 * `created_at <= until` again, which the strict-cursor filter below then
 * re-narrows by timestamp alone. In that dense-second corner case a handful
 * of same-second events on the far side of a page break can be skipped. This
 * is a property of the protocol, not a bug in the reassembly below; buzz-relay
 * avoids it with a real `(created_at, id)` keyset index.
 */

/** How many rows over the timeline-content kinds a TOON history REQ asks for. */
export function buildToonHistoryFilter(
  channelId: string,
  cursor: ChannelWindowCursor | null,
  limit: number,
): RelaySubscriptionFilter {
  const filter: RelaySubscriptionFilter = {
    kinds: [...CHANNEL_TIMELINE_CONTENT_KINDS],
    limit,
    "#h": [channelId],
  };
  if (cursor) filter.until = cursor.createdAt;
  return filter;
}

/**
 * Whether `event` belongs strictly before `cursor` in relay order (older
 * timestamp, or the same timestamp with a lexically greater id — the same
 * tiebreak `compareRelayOrder`/`channelWindowStore.isStrictlyOlder` use).
 *
 * NIP-01's `until` is inclusive and second-granular, so a REQ built from the
 * previous page's boundary timestamp routinely re-delivers the event(s) that
 * timestamp ended on. Dropping anything not strictly older than the cursor
 * keeps a re-fetched boundary from resurrecting a row the retained page
 * already rendered — `channelWindowStore.appendOlderChannelWindow` throws on
 * any id it has already seen, so this filter is what keeps overlapping pages
 * gap-free instead of merely deduped.
 */
function isStrictlyOlder(
  event: RelayEvent,
  cursor: ChannelWindowCursor,
): boolean {
  return (
    event.created_at < cursor.createdAt ||
    (event.created_at === cursor.createdAt && event.id > cursor.eventId)
  );
}

/**
 * Reassemble one TOON history page from a raw, possibly shuffled, possibly
 * duplicated NIP-01 response into the same `ChannelWindowPage` shape the
 * relay's bounds-based parser produces.
 *
 * Ordering and dedup happen here rather than being assumed of the transport:
 * a relay is free to answer a REQ in any order, a reconnect-and-replay can
 * redeliver an event the caller already has, and the wire tolerance in
 * `toonRelayFrames.ts` only guarantees each frame decodes to a well-formed
 * event, not that the set of frames is sorted or unique.
 *
 * `hasMore` is decided from the raw, deduped fetch count against the
 * requested `limit` — *before* the top-level filter below removes thread
 * replies. Deciding it from the visible row count instead would stall
 * scroll-back forever on a page that happens to be all replies (or, upstream
 * of this function, all content this client cannot decrypt): the relay still
 * had a full page to give, so the cursor must still walk forward. `events`
 * should already be `openChannelEvent`-opened by the caller (`channelWindow.ts`)
 * — this function does not care whether a row's content is plaintext or the
 * locked placeholder, only that it exists.
 */
export function assembleToonChannelWindowPage(
  events: RelayEvent[],
  cursor: ChannelWindowCursor | null,
  limit: number,
): ChannelWindowPage {
  const byId = new Map<string, RelayEvent>();
  for (const event of events) byId.set(event.id, event);
  const ordered = [...byId.values()].sort(compareRelayOrder);

  const relayPageFull = ordered.length >= limit;
  const boundary = ordered[ordered.length - 1] ?? null;
  const nextCursor =
    relayPageFull && boundary
      ? { createdAt: boundary.created_at, eventId: boundary.id }
      : null;

  const surviving = cursor
    ? ordered.filter((event) => isStrictlyOlder(event, cursor))
    : ordered;

  // Top-level only, mirroring buzz-relay's `top_level: true` filter. A plain
  // NIP-01 relay has no such flag, so replies are excluded the same way the
  // client already tells them apart for rendering — the NIP-10-style marker
  // tags `threading.isThreadReply` reads.
  const rows: ChannelWindowRow[] = surviving
    .filter((event) => !isThreadReply(event.tags))
    .map((event) => ({ event, thread: null }));

  return {
    startCursor: cursor,
    rows,
    aux: [],
    nextCursor,
    hasMore: nextCursor !== null,
  };
}
