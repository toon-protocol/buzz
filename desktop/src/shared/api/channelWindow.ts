import { parseChannelWindowResponse } from "@/features/messages/lib/channelWindowResponse";
import type {
  ChannelWindowCursor,
  ChannelWindowPage,
} from "@/features/messages/lib/channelWindowStore";
import {
  assembleToonChannelWindowPage,
  buildToonHistoryFilter,
} from "@/features/messages/lib/toonChannelWindowResponse";
import { openChannelEvents } from "@/shared/api/channelMessageCrypto";
import { invokeTauri } from "@/shared/api/tauri";
import { getActiveToonTransport } from "@/shared/api/transportSelection";
import type { ChannelPageCursor, RelayEvent } from "@/shared/api/types";

/**
 * Fetch the flat Nostr event array for one server-assembled channel window.
 *
 * Relay-mode only — buzz-relay's `/query` bridge server-assembles thread
 * summaries and window bounds that a plain NIP-01 relay cannot produce (see
 * `getChannelWindowPage`, which is what call sites should use). Kept as its
 * own function because `parseChannelWindowResponse`'s bounds contract is
 * specific to this response shape.
 */
export async function getChannelWindowEvents(
  channelId: string,
  cursor: ChannelPageCursor | null = null,
  limitRows = 50,
): Promise<RelayEvent[]> {
  const events = await invokeTauri<RelayEvent[]>("get_channel_window", {
    channelId,
    limitRows,
    cursor: cursor
      ? { created_at: cursor.createdAt, event_id: cursor.eventId }
      : null,
  });
  return openChannelEvents(events);
}

/**
 * Fetch one channel window — the newest page when `cursor` is null, otherwise
 * the page immediately older than `cursor` — as a transport-agnostic
 * {@link ChannelWindowPage}.
 *
 * History's entrance into the app, and therefore where history is decrypted —
 * the counterpart to `eventTransport.subscribeLiveEvents`, which does the same
 * for the live tail. Both call the same opener, so a channel reads identically
 * whether a message arrived a second ago or two restarts ago: the key outlives
 * the process (`channelKeyStore.ts`), the ciphertext outlives it on the relay,
 * and a relaunch is not a special case anywhere.
 *
 * This is also the transport seam for reads that `eventTransport.ts` notes
 * history does not yet ride: on TOON, a channel window is a plain NIP-01 REQ
 * against the relay behind the active `ToonEventTransport`, reassembled
 * client-side by `toonChannelWindowResponse.ts`; on the relay transport it
 * stays buzz-relay's server-assembled window. Callers (`hooks.ts`'s newest-page
 * query, `pageOlderMessages.ts`'s scroll-back pass) do not branch on transport
 * themselves — they take whichever `ChannelWindowPage` comes back and hand it
 * to the same `channelWindowStore` reducers either way.
 */
export async function getChannelWindowPage(
  channelId: string,
  cursor: ChannelWindowCursor | null = null,
  limitRows = 50,
): Promise<ChannelWindowPage> {
  const toon = getActiveToonTransport();
  if (toon) {
    const filter = buildToonHistoryFilter(channelId, cursor, limitRows);
    const events = openChannelEvents(await toon.fetchEvents(filter));
    return assembleToonChannelWindowPage(events, cursor, limitRows);
  }

  const events = await getChannelWindowEvents(channelId, cursor, limitRows);
  return parseChannelWindowResponse(events, channelId, cursor);
}
