import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";

import { type ChannelKey, channelKeyId } from "@/shared/api/channelEncryption";
import { findChannelKey, getChannelKeys } from "@/shared/api/channelKeyStore";

/**
 * Blob encryption for keyed channels: the media half of the channel key
 * domain (ADR 0002, buzz#17).
 *
 * A file uploaded to the TOON store node is on Arweave — world-readable,
 * forever, no delete (`storeMediaUploader.ts`). For a public channel that is
 * the deal. For a *keyed* channel it would be a permanent, unrevocable leak of
 * exactly the content the channel key exists to protect, so the bytes have to
 * be ciphertext before they reach the paid write. Not "should be": there is no
 * second chance, and no operator to ask.
 *
 * ## Why not NIP-44 over the file
 *
 * Messages are sealed with NIP-44 v2 (`channelEncryption.ts`) and the obvious
 * move is to do the same to the blob. NIP-44 v2 caps a payload at 65535 bytes
 * of plaintext, which every photograph exceeds, so that path means inventing a
 * chunk framing — a length prefix, an ordering rule, a per-chunk MAC and a
 * whole-file MAC to stop chunk reordering and truncation. That is a new
 * cryptographic construction, written here, defended here, and it would be the
 * only hand-rolled crypto in the app.
 *
 * ## What this does instead
 *
 * One AEAD pass over the whole file with a key *derived from the channel key*:
 *
 * ```
 * salt      = 32 random bytes, fresh per blob
 * blobKey   = HKDF-SHA256(ikm = channelKey, salt, info = "buzz/channel-media/v1")
 * ciphertext= AES-256-GCM(blobKey, iv = 12 random bytes, plaintext)
 * ```
 *
 * Both primitives are standard and neither is ours: HKDF from `@noble/hashes`
 * (the same library NIP-44 itself derives with) and AES-256-GCM from WebCrypto.
 *
 * ## Derived, not wrapped — and why that matters
 *
 * The textbook alternative is a random per-file key wrapped under the channel
 * key and carried alongside the file. ADR 0002 considered and rejected exactly
 * that ("per-file keys wrapped into the referencing message"), because a
 * wrapped key is a *separable* grant: it can be unwrapped once and handed to
 * someone who was never in the channel, and then the channel key is no longer
 * what gates the file.
 *
 * Derivation has no such object. The blob key is a pure function of the
 * channel key and a public salt, so "can decrypt this file" and "holds this
 * channel's key" are the same statement — which is what ADR 0002 means by one
 * key domain for messages and media. The salt is not a secret and carries no
 * access; it exists so two files sealed under one channel key never share a
 * key, which is what keeps a 96-bit GCM IV safe.
 *
 * ## Rotation
 *
 * {@link SealedMediaEnvelope.keyId} names the epoch that derived the blob key,
 * exactly as the `["encrypted", "nip44-v2", keyId]` marker names the epoch that
 * sealed a message. Resolution goes through the same ring
 * (`channelKeyStore.findChannelKey`), so the semantics fall out rather than
 * being restated:
 *
 * - A member who holds the ring opens media from every epoch in it, including
 *   files posted before they joined if they were given those keys — the same
 *   answer the message path gives for history.
 * - A *removed* member holds the pre-rotation ring and nothing after it. Media
 *   posted after the rotation derives from a key they do not have, so it stays
 *   ciphertext for them forever. That is the point of rotating, and it is the
 *   one property media could not have had if the file key were independent of
 *   the channel key.
 *
 * ## What this does not protect
 *
 * The ciphertext is permanent and public. Anyone can see that a file of that
 * size was posted to that channel at that time, and anyone who later obtains
 * the channel key can read every file ever posted under it — retroactively,
 * with no way to withdraw them. ADR 0002 names this consequence; this module
 * cannot soften it.
 */

/**
 * Scheme identifier stamped on every envelope.
 *
 * Named rather than assumed, for the same reason `NIP44_V2_SCHEME` is: a later
 * construction has to be able to coexist with files already on the permaweb,
 * which by definition cannot be re-encrypted.
 */
export const CHANNEL_MEDIA_SCHEME = "hkdf-sha256/aes-256-gcm/v1";

/**
 * HKDF `info` string — domain separation from every other use of the channel
 * key, present and future. Changing it invalidates every blob ever sealed.
 */
const HKDF_INFO = "buzz/channel-media/v1";

/** HKDF salt width. 32 bytes so per-blob keys never collide in practice. */
const SALT_BYTES = 32;

/** AES-GCM's native IV width. Random is safe because the key is per-blob. */
const IV_BYTES = 12;

/** Derived key width — AES-256. */
const BLOB_KEY_BYTES = 32;

/**
 * What a reader needs to turn permaweb ciphertext back into a file, plus the
 * plaintext facts the renderer would otherwise have to read from a tag.
 *
 * Every field here is carried inside the *sealed* message content
 * (`mediaEnvelopeContent.ts`), never in a tag. The split is deliberate: `mime`,
 * `size`, `dim` and `filename` describe the plaintext, and on an open relay a
 * tag is a broadcast. "A 2.4 MB `image/png` named `q3-revenue.png`" is most of
 * what an attachment says even when its bytes are unreadable.
 *
 * `salt` and `iv` are not secret — they are useless without the channel key —
 * but they ride in the same place because there is no reason to split the
 * record and every reason for it to arrive as one thing.
 */
export type SealedMediaEnvelope = {
  /** Envelope version, for a future shape change. */
  v: 1;
  /** Construction that produced the ciphertext. See {@link CHANNEL_MEDIA_SCHEME}. */
  alg: string;
  /** Public id of the channel-key epoch this blob's key derives from. */
  keyId: string;
  /** HKDF salt, hex. Fresh per blob. */
  salt: string;
  /** AES-GCM IV, hex. */
  iv: string;
  /** Plaintext content type — what to render the decrypted bytes as. */
  mime: string;
  /** Plaintext byte length. */
  size: number;
  /**
   * SHA-256 of the *ciphertext*, hex.
   *
   * The identity the public world can check: it is what `imeta x` carries and
   * therefore what a `["x", …]` tombstone names. Hashing the plaintext there
   * would hand every observer a confirmation oracle — "is this the file?" — for
   * content whose whole point is that they cannot read it.
   */
  sha256: string;
  /** Plaintext pixel dimensions, `WIDTHxHEIGHT`, when they could be read. */
  dim?: string;
  /** Original filename, when the upload had one. */
  filename?: string;
};

/** Plaintext facts the caller knows and the envelope has to carry. */
export type MediaPlaintextInfo = {
  mime: string;
  dim?: string;
  filename?: string;
};

const HEX_RE = /^[0-9a-f]*$/i;

function isHex(value: unknown, bytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length === bytes * 2 &&
    HEX_RE.test(value)
  );
}

/**
 * Whether `value` is an envelope this build can act on.
 *
 * Total and defensive: envelopes arrive from decrypted message content written
 * by another client, possibly a newer one. An unrecognised shape has to read as
 * "cannot open this" rather than throw somewhere in the render tree.
 */
export function isSealedMediaEnvelope(
  value: unknown,
): value is SealedMediaEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.alg === "string" &&
    typeof record.keyId === "string" &&
    isHex(record.salt, SALT_BYTES) &&
    isHex(record.iv, IV_BYTES) &&
    typeof record.mime === "string" &&
    typeof record.size === "number" &&
    isHex(record.sha256, 32) &&
    (record.dim === undefined || typeof record.dim === "string") &&
    (record.filename === undefined || typeof record.filename === "string")
  );
}

/** Lowercase hex SHA-256 of `bytes`. */
export function mediaSha256(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * The AES-256 key for one blob: HKDF-SHA256 over the channel key.
 *
 * Exported for tests, which need to prove that the same channel key and salt
 * derive the same bytes and that a different channel key does not.
 */
export function deriveBlobKey(
  channelKey: ChannelKey,
  salt: Uint8Array,
): Uint8Array {
  return hkdf(sha256, channelKey, salt, utf8ToBytes(HKDF_INFO), BLOB_KEY_BYTES);
}

/**
 * WebCrypto refuses views onto a `SharedArrayBuffer`, and Tauri's IPC bridge
 * hands us arrays we did not allocate. Copying is cheap next to the AEAD pass.
 */
function detach(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function importBlobKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", detach(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Seal `plaintext` for the channel key `key`.
 *
 * Returns the bytes to upload and the envelope that opens them. The caller is
 * expected to upload *only* the returned ciphertext — see
 * `storeMediaUploader.ts`, where that ordering is the invariant the whole
 * feature rests on.
 */
export async function encryptChannelMedia(
  plaintext: Uint8Array,
  key: ChannelKey,
  info: MediaPlaintextInfo,
): Promise<{ ciphertext: Uint8Array; envelope: SealedMediaEnvelope }> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const blobKey = await importBlobKey(deriveBlobKey(key, salt));

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: detach(iv) },
      blobKey,
      detach(plaintext),
    ),
  );

  return {
    ciphertext: sealed,
    envelope: {
      v: 1,
      alg: CHANNEL_MEDIA_SCHEME,
      keyId: channelKeyId(key),
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      mime: info.mime,
      size: plaintext.byteLength,
      sha256: mediaSha256(sealed),
      ...(info.dim ? { dim: info.dim } : {}),
      ...(info.filename ? { filename: info.filename } : {}),
    },
  };
}

/**
 * Open `ciphertext` with an explicit channel key, or null when it cannot.
 *
 * Null rather than a throw, for the same reason `decryptChannelContent`
 * collapses to null: on an open relay a non-member holding the wrong key is the
 * *ordinary* case, and a corrupted blob wants identical handling. GCM's tag
 * makes the two indistinguishable anyway.
 */
export async function decryptChannelMediaWithKey(
  ciphertext: Uint8Array,
  envelope: SealedMediaEnvelope,
  key: ChannelKey,
): Promise<Uint8Array | null> {
  if (envelope.alg !== CHANNEL_MEDIA_SCHEME) return null;
  try {
    const blobKey = await importBlobKey(
      deriveBlobKey(key, hexToBytes(envelope.salt)),
    );
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: detach(hexToBytes(envelope.iv)) },
      blobKey,
      detach(ciphertext),
    );
    return new Uint8Array(opened);
  } catch {
    return null;
  }
}

/**
 * Open `ciphertext` with whichever of `channelId`'s keys sealed it.
 *
 * The envelope names the epoch, so the common path is one lookup and one AEAD
 * pass rather than a search over the ring. The fallback — try every held key —
 * mirrors `channelMessageCrypto.openWithHeldKeys`: a `keyId` this client cannot
 * resolve may still name bytes it holds under a different derivation, and the
 * ring is a handful of keys, reached only after the named lookup already
 * failed.
 *
 * Null is the answer for a non-member and for a removed member reading
 * post-rotation media. Both are correct outcomes, not errors.
 */
export async function decryptChannelMedia(
  ciphertext: Uint8Array,
  envelope: SealedMediaEnvelope,
  channelId: string,
): Promise<Uint8Array | null> {
  const named = envelope.keyId
    ? findChannelKey(channelId, envelope.keyId)
    : null;
  if (named) return decryptChannelMediaWithKey(ciphertext, envelope, named);

  for (const key of getChannelKeys(channelId)) {
    const opened = await decryptChannelMediaWithKey(ciphertext, envelope, key);
    if (opened !== null) return opened;
  }
  return null;
}
