import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import {
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
} from "nostr-tools/nip44";

/**
 * The channel-key primitives: one shared symmetric key per encrypted channel,
 * NIP-44 v2 for the sealing itself.
 *
 * Privacy in Buzz-on-TOON is cryptographic, never relay-enforced (ADR 0001):
 * the relay serves every reader, so anything that must stay private has to
 * leave this process already sealed. Possession of the current channel key IS
 * membership — this module is the whole trust boundary that statement rests
 * on.
 *
 * Nothing here is hand-rolled. NIP-44 v2 (`nostr-tools/nip44`) takes a 32-byte
 * *conversation key* and derives a per-message key with HKDF over a random
 * 32-byte nonce, then encrypts with ChaCha20 and authenticates with
 * HMAC-SHA256. Direct messages produce that conversation key from an ECDH
 * shared secret; an encrypted group produces it from a key everyone already
 * holds. The channel key IS the conversation key — same construction, same
 * padded ciphertext, different way of agreeing on 32 bytes.
 *
 * How those 32 bytes get to the second client is deliberately out of scope:
 * today a human copies them (see `channelKeyStore.ts`), and the gift-wrapped
 * delivery and admin-triggered rotation that replace that are separate work.
 * The forward hook is {@link channelKeyId}: every sealed message names the key
 * that sealed it, so a client holding several keys for one channel — which is
 * exactly what rotation produces — can pick the right one without trial
 * decryption.
 */

/** NIP-44 v2 conversation keys are 32 bytes; so, therefore, are channel keys. */
export const CHANNEL_KEY_BYTES = 32;

/**
 * A channel key: 32 raw bytes, never a string.
 *
 * Kept as bytes so the hex form only exists where a human has to read or type
 * it — the UI field and the storage record. Everything else passes the array.
 */
export type ChannelKey = Uint8Array;

/** Key ids are a truncated hash, long enough that a collision is not a concern. */
const KEY_ID_HEX_LENGTH = 16;

/**
 * Domain separation for {@link channelKeyId}.
 *
 * The id is published in a tag on every encrypted event, so it must be
 * unusable as an oracle for the key itself. Hashing under a label no other
 * protocol uses means the published value cannot be replayed as a proof about
 * the key in some other context.
 */
const KEY_ID_DOMAIN = "buzz/channel-key-id/v1";

const HEX_64_RE = /^[0-9a-f]{64}$/i;

/** A fresh channel key from the platform CSPRNG. */
export function generateChannelKey(): ChannelKey {
  return randomBytes(CHANNEL_KEY_BYTES);
}

/**
 * Read a channel key a human pasted, or null when it is not one.
 *
 * Tolerant about presentation (whitespace, case, an `0x` prefix) and strict
 * about substance: exactly 32 bytes of hex. A truncated paste that silently
 * became a shorter key would encrypt with something neither client agreed on
 * and fail as "wrong key" much later.
 */
export function parseChannelKey(
  text: string | null | undefined,
): ChannelKey | null {
  const trimmed = text?.trim().replace(/\s+/g, "") ?? "";
  const withoutPrefix = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!HEX_64_RE.test(withoutPrefix)) return null;
  return hexToBytes(withoutPrefix.toLowerCase());
}

/** The key as the lowercase hex a human copies between two clients. */
export function formatChannelKey(key: ChannelKey): string {
  return bytesToHex(key);
}

/**
 * A public, non-reversible name for a key.
 *
 * Travels in the clear on every encrypted event so a reader can tell "I do not
 * have this channel's key" apart from "I have the wrong one", and so a client
 * that holds a pre- and a post-rotation key knows which to reach for.
 */
export function channelKeyId(key: ChannelKey): string {
  const labelled = new Uint8Array([...utf8ToBytes(KEY_ID_DOMAIN), ...key]);
  return bytesToHex(sha256(labelled)).slice(0, KEY_ID_HEX_LENGTH);
}

/** Seal `plaintext` under `key`, returning the NIP-44 v2 base64 payload. */
export function encryptChannelContent(
  plaintext: string,
  key: ChannelKey,
): string {
  return nip44Encrypt(plaintext, key);
}

/**
 * Open a NIP-44 v2 payload, or null when `key` cannot.
 *
 * Null is the *expected* outcome for a reader without the key, not an error
 * condition: on an open relay every client sees every ciphertext, so failure
 * to decrypt is the ordinary case for anyone outside the group. NIP-44's MAC
 * makes the wrong key indistinguishable from a corrupted payload, and callers
 * want the same handling for both, so both collapse to null.
 */
export function decryptChannelContent(
  payload: string,
  key: ChannelKey,
): string | null {
  try {
    return nip44Decrypt(payload, key);
  } catch {
    return null;
  }
}
