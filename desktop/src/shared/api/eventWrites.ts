import { buildThreadReferenceTags } from "@/features/messages/lib/threading";
import {
  ensureTransportReady,
  isTransportWritable,
  publishEphemeralEvent,
  publishEvent,
} from "@/shared/api/eventTransport";
import { signRelayEvent } from "@/shared/api/tauri";
import type { PresenceStatus, RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_TYPING_INDICATOR,
  KIND_USER_STATUS,
} from "@/shared/constants/kinds";

/**
 * Buzz's own write verbs: build the tags, sign through Tauri, hand the signed
 * event to the transport seam. They sit *upstream* of the seam on purpose —
 * event shape is protocol, not transport, so a second transport inherits all
 * of it for free.
 */

/**
 * Post a plain kind:11 message to a channel.
 *
 * Not the only way a message reaches the relay: messages that carry threading,
 * media, or emoji tags go through the Tauri `send_channel_message` command
 * instead, which builds, signs, and POSTs the event from Rust over NIP-98
 * HTTP. That surface is not on this seam — see `eventTransport.ts`.
 */
export async function sendStreamMessage(
  channelId: string,
  content: string,
  mentionPubkeys: string[] = [],
  extraTags: string[][] = [],
): Promise<RelayEvent> {
  await ensureTransportReady();

  const tags: string[][] = [["h", channelId]];
  for (const pubkey of mentionPubkeys) {
    tags.push(["p", pubkey]);
  }
  for (const tag of extraTags) {
    tags.push(tag);
  }

  const event = await signRelayEvent({
    kind: KIND_STREAM_MESSAGE,
    content: content.trim(),
    tags,
  });

  return publishEvent(
    event,
    "Timed out while sending the message.",
    "Failed to send the message.",
  );
}

/** Broadcast the signed-in user's presence. */
export async function sendPresence(
  status: PresenceStatus,
): Promise<RelayEvent> {
  await ensureTransportReady();

  const event = await signRelayEvent({
    kind: 20001,
    content: status,
    tags: [],
  });

  return publishEvent(
    event,
    "Timed out while updating presence.",
    "Failed to update presence.",
  );
}

/** Announce that the user is typing. Dropped when the transport cannot write. */
export async function sendTypingIndicator(
  channelId: string,
  parentEventId?: string | null,
  rootEventId?: string | null,
): Promise<void> {
  // Bail before signing — not worth an IPC round-trip for an event the
  // transport would only drop.
  if (!isTransportWritable()) {
    return;
  }

  const event = await signRelayEvent({
    kind: KIND_TYPING_INDICATOR,
    content: "",
    tags: buildThreadReferenceTags(
      channelId,
      parentEventId ?? null,
      rootEventId ?? null,
    ),
  });

  await publishEphemeralEvent(event);
}

/** Publish the user's kind:30315 status line. */
export async function publishUserStatus(
  text: string,
  emoji: string,
): Promise<void> {
  await ensureTransportReady();

  const tags: string[][] = [["d", "general"]];
  if (emoji) tags.push(["emoji", emoji]);

  const event = await signRelayEvent({
    kind: KIND_USER_STATUS,
    content: text,
    tags,
  });

  await publishEvent(
    event,
    "Timed out publishing user status",
    "Failed to publish user status",
  );
}
