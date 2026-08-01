import {
  buildMediaTombstoneTags,
  KIND_MEDIA_TOMBSTONE,
} from "@/features/messages/lib/mediaTombstone";
import { buildThreadReferenceTags } from "@/features/messages/lib/threading";
import {
  openChannelEvent,
  sealChannelContent,
} from "@/shared/api/channelMessageCrypto";
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
 * Post a plain kind:9 message to a channel, sealed with the channel key when
 * this client holds one.
 *
 * The sealing happens here rather than in a transport because encryption is a
 * property of the channel, not of the wire — and because content sealed after
 * `signRelayEvent` would not be content the signature covers. See
 * `channelMessageCrypto.ts` for the wire layout and the placement argument.
 *
 * Not the only way a message reaches the relay: messages that carry threading,
 * media, or emoji tags go through the Tauri `send_channel_message` command
 * instead, which builds, signs, and POSTs the event from Rust over NIP-98
 * HTTP. That surface is not on this seam — see `eventTransport.ts` — and so is
 * NOT encrypted; an encrypted channel's replies and attachments still go out
 * in the clear until the Rust write path grows a seam of its own.
 */
export async function sendStreamMessage(
  channelId: string,
  content: string,
  mentionPubkeys: string[] = [],
  extraTags: string[][] = [],
): Promise<RelayEvent> {
  await ensureTransportReady();

  const sealed = sealChannelContent(channelId, content.trim());

  const tags: string[][] = [["h", channelId], ...sealed.tags];
  for (const pubkey of mentionPubkeys) {
    tags.push(["p", pubkey]);
  }
  for (const tag of extraTags) {
    tags.push(tag);
  }

  const event = await signRelayEvent({
    kind: KIND_STREAM_MESSAGE,
    content: sealed.content,
    tags,
  });

  const published = await publishEvent(
    event,
    "Timed out while sending the message.",
    "Failed to send the message.",
  );

  // Back through the same door inbound events come in by, so the sender's own
  // echo is the plaintext everyone else will see rather than its own ciphertext.
  return openChannelEvent(published);
}

/**
 * Withdraw attachments from a message: publish a media tombstone.
 *
 * Named `hide`, not `delete`, everywhere it appears — the bytes are on Arweave
 * and stay there (ADR 0002). What this publishes is a signed request that
 * clients stop rendering the named attachments, and that is all it can ever
 * be. See `mediaTombstone.ts` for the event shape and the reasoning.
 *
 * Not encrypted: a tombstone carries no content, only hashes of blobs whose
 * existence is already public.
 */
export async function hideChannelMedia(
  channelId: string,
  eventId: string,
  sha256s: ReadonlyArray<string>,
): Promise<RelayEvent> {
  await ensureTransportReady();

  const event = await signRelayEvent({
    kind: KIND_MEDIA_TOMBSTONE,
    content: "",
    tags: buildMediaTombstoneTags({ channelId, eventId, sha256s }),
  });

  return publishEvent(
    event,
    "Timed out while hiding the attachments.",
    "Failed to hide the attachments.",
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
