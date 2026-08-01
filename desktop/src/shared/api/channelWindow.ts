import { openChannelEvents } from "@/shared/api/channelMessageCrypto";
import { invokeTauri } from "@/shared/api/tauri";
import type { ChannelPageCursor, RelayEvent } from "@/shared/api/types";

/**
 * Fetch the flat Nostr event array for one server-assembled channel window.
 *
 * History's entrance into the app, and therefore where history is decrypted —
 * the counterpart to `eventTransport.subscribeLiveEvents`, which does the same
 * for the live tail. Both call the same opener, so a channel reads identically
 * whether a message arrived a second ago or two restarts ago: the key outlives
 * the process (`channelKeyStore.ts`), the ciphertext outlives it on the relay,
 * and a relaunch is not a special case anywhere.
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
