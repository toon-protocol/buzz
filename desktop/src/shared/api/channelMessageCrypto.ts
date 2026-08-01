import {
  type ChannelKey,
  channelKeyId,
  decryptChannelContent,
  encryptChannelContent,
} from "@/shared/api/channelEncryption";
import {
  findChannelKey,
  getChannelKey,
  getChannelKeys,
} from "@/shared/api/channelKeyStore";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Channel-key encryption at the event level: seal on the way out, open on the
 * way in.
 *
 * ## Where this sits
 *
 * Above the transport seam, always. `eventTransport.ts` carries a *signed*
 * event, and content sealed after signing is content the signature no longer
 * covers — so sealing has to happen before `signRelayEvent`, in the write verb
 * (`eventWrites.sendStreamMessage`). Opening is placed to match: the seam's
 * `subscribeLiveEvents` for the tail and `channelWindow.getChannelWindowPage`
 * for history, both of which are the transport-agnostic facade rather than any
 * one transport.
 *
 * That placement is the point. Encryption is a property of the *channel*, not
 * of the network the bytes crossed: the relay transport and the TOON transport
 * hand the same sealed event to different wires, and a third transport
 * inherits encryption without knowing it exists. Pushing it into
 * `ToonEventTransport` would have been fewer edits and would have quietly made
 * privacy depend on `BUZZ_TRANSPORT`.
 *
 * ## What is sealed, and what is not
 *
 * Only `content`. Tags stay in the clear because they are routing metadata the
 * client itself needs before it can decide whether to decrypt anything —
 * `h` says which channel, and therefore which key. ADR 0001 accepts that: the
 * relay learns the shape of the traffic, never its substance.
 *
 * The `p` tags on a message are the exception worth naming. They carry mention
 * pubkeys so a mentioned member gets notified without every client decrypting
 * every message first, which means an observer learns who was addressed in a
 * private channel. That is a real leak, taken knowingly for notifications.
 *
 * ## Wire layout
 *
 * Kind is unchanged — an encrypted channel message is still `kind:9` with its
 * `["h", <channelId>]` tag, exactly as the plaintext path and the TOON tracer
 * bullet (#11) publish it, so nothing about reading, paying, or routing has a
 * second case to handle. What changes is `content`, which becomes a NIP-44 v2
 * payload, plus one marker tag:
 *
 * ```
 * ["encrypted", "nip44-v2", "<keyId>"]
 * ```
 *
 * The scheme is named rather than assumed so a later one can coexist, and the
 * key id is named so a client holding more than one key for a channel — what
 * rotation produces — can choose without trial decryption.
 */

/** Tag name declaring an event's content sealed. */
export const ENCRYPTION_TAG = "encrypted";

/** The only sealing scheme this build understands. */
export const NIP44_V2_SCHEME = "nip44-v2";

/**
 * Stand-in content for a message this client cannot open.
 *
 * Shown rather than hidden: on an open relay a non-member sees these events
 * regardless, and a visible gap is more honest than a timeline that silently
 * skips messages it could not read.
 */
export const LOCKED_MESSAGE_PLACEHOLDER =
  "[Encrypted message — this client does not have the channel key.]";

/** What a channel write contributes to an event before it is signed. */
export type SealedChannelContent = {
  content: string;
  /** Marker tag, or nothing at all when the channel is not encrypted. */
  tags: string[][];
};

/**
 * What happened when an event was opened.
 *
 * Local-only, like `RelayEvent.pending`: attached on the way in and never on
 * the wire. Its presence means `content` is no longer the bytes the signature
 * covers — `payload` is. It lives here rather than on `RelayEvent` because
 * nothing outside this module puts it there.
 */
export type EventEncryption = {
  /** Sealing scheme, from the event's `encrypted` tag. */
  scheme: string;
  /** Public id of the key that sealed it (see `channelKeyId`). */
  keyId: string;
  /** The ciphertext as it arrived. */
  payload: string;
  /** False when this client holds no key that opens it. */
  opened: boolean;
};

/** An inbound event after {@link openChannelEvent} has had a look at it. */
export type OpenedRelayEvent = RelayEvent & { encryption?: EventEncryption };

/** The `encrypted` marker on an event, or null when it carries none. */
export function readEncryptionTag(
  tags: string[][],
): { scheme: string; keyId: string } | null {
  for (const tag of tags) {
    if (tag[0] !== ENCRYPTION_TAG) continue;
    return { scheme: tag[1] ?? "", keyId: tag[2] ?? "" };
  }
  return null;
}

/** The `h` tag: which channel an event belongs to, and so which key opens it. */
export function readChannelTag(tags: string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] === "h" && tag[1]) return tag[1];
  }
  return null;
}

/**
 * Seal `content` for `channelId` if this client holds that channel's key.
 *
 * A channel with no key is not an error — most channels are public, and the
 * caller gets its plaintext back with no marker tag. Encryption is switched on
 * by the presence of a key and nothing else, so there is no state in which a
 * channel is marked private but posts in the clear.
 */
export function sealChannelContent(
  channelId: string,
  content: string,
  key: ChannelKey | null = getChannelKey(channelId),
): SealedChannelContent {
  if (key === null) return { content, tags: [] };
  return {
    content: encryptChannelContent(content, key),
    tags: [[ENCRYPTION_TAG, NIP44_V2_SCHEME, channelKeyId(key)]],
  };
}

/**
 * Open `payload` with whichever of `channelId`'s keys sealed it.
 *
 * The marker tag names the key, so after a rotation the right one is a lookup
 * rather than a search: a client holding four epochs does one NIP-44 decrypt,
 * not four (`channelKeyStore.findChannelKey`).
 *
 * The fallback — try the rest of the ring — exists for a message whose marker
 * names a key id this client cannot resolve but whose bytes it may still hold:
 * an event written by a client on a different key-id derivation, or a tag
 * mangled in transit. Bounded by the ring (at most a handful) and reached only
 * when the lookup already failed, so the common path stays one decrypt while a
 * mislabelled message does not become permanently unreadable.
 */
function openWithHeldKeys(
  channelId: string,
  keyId: string,
  payload: string,
): string | null {
  const named = keyId ? findChannelKey(channelId, keyId) : null;
  if (named) return decryptChannelContent(payload, named);

  for (const key of getChannelKeys(channelId)) {
    const plaintext = decryptChannelContent(payload, key);
    if (plaintext !== null) return plaintext;
  }
  return null;
}

function lockedEncryption(
  event: RelayEvent,
  scheme: string,
  keyId: string,
): EventEncryption {
  return { scheme, keyId, payload: event.content, opened: false };
}

/**
 * Open an inbound event, or mark it locked.
 *
 * Returns the *same object* when there is nothing to do, which is the common
 * case — every public channel, every reaction, every read-state event. React
 * caches compare these by reference, so a copy-on-every-event would invalidate
 * timelines that did not change.
 *
 * Never throws. A wrong key, a corrupted payload and an unknown scheme all
 * land on the same locked result: on an open relay, being unable to read
 * someone else's channel is the ordinary case, not a failure.
 */
export function openChannelEvent(
  event: RelayEvent,
  key: ChannelKey | null = null,
): OpenedRelayEvent {
  const marker = readEncryptionTag(event.tags);
  if (marker === null) return event;

  if (marker.scheme !== NIP44_V2_SCHEME) {
    return {
      ...event,
      content: LOCKED_MESSAGE_PLACEHOLDER,
      encryption: lockedEncryption(event, marker.scheme, marker.keyId),
    };
  }

  const channelId = readChannelTag(event.tags);
  const plaintext =
    key !== null
      ? decryptChannelContent(event.content, key)
      : channelId === null
        ? null
        : openWithHeldKeys(channelId, marker.keyId, event.content);

  if (plaintext === null) {
    return {
      ...event,
      content: LOCKED_MESSAGE_PLACEHOLDER,
      encryption: lockedEncryption(event, marker.scheme, marker.keyId),
    };
  }

  return {
    ...event,
    content: plaintext,
    encryption: {
      scheme: marker.scheme,
      keyId: marker.keyId,
      payload: event.content,
      opened: true,
    },
  };
}

/** {@link openChannelEvent} over a page of history. */
export function openChannelEvents(events: RelayEvent[]): OpenedRelayEvent[] {
  return events.map((event) => openChannelEvent(event));
}
