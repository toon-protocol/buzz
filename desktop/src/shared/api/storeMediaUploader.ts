import { arweaveMediaUrls } from "@/shared/lib/arweaveMedia";
import {
  encryptChannelMedia,
  mediaSha256,
} from "@/shared/api/channelMediaCrypto";
import { getChannelKey } from "@/shared/api/channelKeyStore";
import {
  type MediaPickOptions,
  MediaUploadUnavailable,
  type MediaUploader,
  type MediaUploadQuote,
  type MediaUploadRequest,
  type UploadedMedia,
} from "@/shared/api/mediaUpload";
import { pickMediaBytes } from "@/shared/api/tauriMedia";
import type { ToonPaidWriter } from "@/shared/api/toonPaidWriter";

/**
 * The TOON store node as a media backend: a paid ILP write whose payload is
 * blob bytes and whose receipt is an Arweave transaction id (ADR 0002).
 *
 * Structurally this is the media twin of `ToonEventTransport` — a shape
 * adapter over `ToonPaidWriter`, which owns the client, the channel, and the
 * fee. The interesting difference from Blossom is not the payment, it is that
 * there is no counterpart to Blossom's delete: once `uploadBlob` resolves, the
 * bytes are on the permaweb and every client that ever sees the tx id can
 * fetch them. Nothing in this module offers, implies, or wraps a removal.
 */

/** Content types we can recognise from magic bytes alone. */
const MAGIC_SIGNATURES: ReadonlyArray<{
  mime: string;
  offset: number;
  bytes: readonly number[];
}> = [
  { mime: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP is RIFF....WEBP — the size field sits between the two markers.
  { mime: "image/webp", offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { mime: "video/mp4", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { mime: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** Last-resort MIME lookup when the bytes carry no signature we know. */
const EXTENSION_MIME: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webm: "video/webm",
  webp: "image/webp",
};

/**
 * The content type to declare for `data`.
 *
 * Magic bytes first, filename extension second, `application/octet-stream`
 * last. Sniffing beats the extension because the extension is attacker- (or
 * just user-) supplied and the bytes are not, and because paste and drag-drop
 * often arrive with no filename at all.
 *
 * Exported for tests: the precedence between a lying extension and honest
 * bytes is the part worth pinning down.
 */
export function detectContentType(
  data: readonly number[],
  filename?: string,
): string {
  for (const signature of MAGIC_SIGNATURES) {
    const matches = signature.bytes.every(
      (byte, index) => data[signature.offset + index] === byte,
    );
    if (matches) return signature.mime;
  }
  const extension = filename?.toLowerCase().split(".").pop();
  return (extension && EXTENSION_MIME[extension]) ?? "application/octet-stream";
}

/**
 * Content type declared for a sealed blob.
 *
 * Opaque on purpose: the whole point of encrypting is that the store node, the
 * gateway, and every reader of the `imeta` tag learn nothing about the file.
 * The real type is in the envelope, inside the sealed message content.
 */
const SEALED_CONTENT_TYPE = "application/octet-stream";

/**
 * Pixel dimensions as the `WIDTHxHEIGHT` string `imeta dim` wants, or
 * undefined when they cannot be read.
 *
 * Best-effort on purpose: `dim` only reserves layout space so the timeline
 * does not jump, and a decode failure is not a reason to fail an upload the
 * user has already paid for.
 */
async function measureImage(
  data: Uint8Array,
  contentType: string,
): Promise<string | undefined> {
  if (!contentType.startsWith("image/")) return undefined;
  if (typeof createImageBitmap !== "function" || typeof Blob !== "function") {
    return undefined;
  }
  try {
    const bitmap = await createImageBitmap(
      new Blob([data as unknown as BlobPart], { type: contentType }),
    );
    const dim = `${bitmap.width}x${bitmap.height}`;
    bitmap.close?.();
    return dim;
  } catch {
    return undefined;
  }
}

export class StoreMediaUploader implements MediaUploader {
  private readonly writer: ToonPaidWriter;

  constructor(writer: ToonPaidWriter) {
    this.writer = writer;
  }

  /**
   * The store route's price, or a refusal.
   *
   * An unpriced route is reported as {@link MediaUploadUnavailable} rather than
   * as free. `getRoutePrice` returning null means the edge is not terminating
   * the store address, so an upload would be refused downstream — after the
   * user had accepted a permanence disclosure quoting a fee of zero. Since
   * every upload path quotes before it moves bytes, raising here is what makes
   * "refuse to attempt the upload" true by construction rather than by each
   * call site remembering to check.
   */
  async quote(): Promise<MediaUploadQuote> {
    let amount: bigint;
    try {
      amount = await this.writer.quoteStoreFee();
    } catch (error) {
      throw new MediaUploadUnavailable(
        "Upload unavailable — the TOON store route is unpriced or unreachable, so attachments cannot be uploaded right now.",
        { cause: error },
      );
    }
    return {
      amount,
      asset: "USDC",
      assetScale: 6,
      permanent: true,
      backend: "store",
    };
  }

  /**
   * Pay for one blob and describe where it landed.
   *
   * ## The invariant
   *
   * When `channelId` names a channel this client holds a key for, the bytes
   * handed to `uploadBlob` are ciphertext. Not "usually", not "if the caller
   * remembered": this method is the only route from composer bytes to a paid
   * store write, and the branch is here rather than at a call site, so there is
   * no arrangement of the UI that puts a private channel's plaintext on the
   * permaweb. Arweave has no delete (ADR 0002) — a leak here is not a bug that
   * can be fixed afterwards, so it has to be one that cannot be written.
   *
   * ## What the descriptor then describes
   *
   * The ciphertext, in every field: `sha256` over the sealed bytes, `size` of
   * the sealed bytes, `type` opaque. Those are the values that reach the public
   * `imeta` tag, and they are the ones a `["x", …]` tombstone has to name for
   * the hide path to keep working unchanged. The plaintext's mime, size,
   * dimensions and filename go into `encryption`, which the send path folds
   * into the *sealed* message content.
   *
   * Dimensions are measured before sealing, from the real image, because after
   * sealing there is no image to measure — and a reader who cannot decrypt has
   * no business knowing them anyway.
   */
  async upload({
    data,
    filename,
    channelId,
  }: MediaUploadRequest): Promise<UploadedMedia> {
    if (data.length === 0) throw new Error("empty upload");

    // Quote before hashing, not just before paying: an unpriced route must
    // refuse the upload outright, and there is no reason to spend time on
    // bytes that are not going anywhere.
    await this.quote();

    const plaintext = Uint8Array.from(data);
    const contentType = detectContentType(data, filename);
    const dim = await measureImage(plaintext, contentType);
    const channelKey = channelId ? getChannelKey(channelId) : null;
    const uploaded = Math.floor(Date.now() / 1000);

    if (channelKey !== null) {
      const { ciphertext, envelope } = await encryptChannelMedia(
        plaintext,
        channelKey,
        {
          mime: contentType,
          ...(dim ? { dim } : {}),
          ...(filename ? { filename } : {}),
        },
      );
      const { txId } = await this.writer.uploadBlob(
        ciphertext,
        SEALED_CONTENT_TYPE,
      );
      return {
        url: arweaveMediaUrls(txId).url,
        sha256: envelope.sha256,
        size: ciphertext.byteLength,
        type: SEALED_CONTENT_TYPE,
        uploaded,
        encryption: envelope,
      };
    }

    const { txId } = await this.writer.uploadBlob(plaintext, contentType);
    // Every gateway serves the same bytes, so the descriptor carries the
    // locally-preferred one. Readers re-derive the rest from the tx id in the
    // URL (`arweaveMediaCandidates`), which is why no `fallback` list has to
    // survive the imeta round-trip for fallover to work on the other client.
    const { url } = arweaveMediaUrls(txId);

    return {
      url,
      sha256: mediaSha256(plaintext),
      size: plaintext.byteLength,
      type: contentType,
      uploaded,
      ...(dim ? { dim } : {}),
      ...(filename ? { filename } : {}),
    };
  }

  /**
   * Native picker, then one paid upload per file.
   *
   * The picker itself stays in Rust — the renderer must not learn filesystem
   * paths, and the pre-upload pipeline there (MIME validation, HEIC→JPEG and
   * video transcodes) is the same work a Blossom upload does. Only the
   * destination differs, so `pick_media_bytes` stops one step short of the
   * relay and hands the prepared bytes back.
   *
   * Sequential rather than concurrent: each upload spends a channel claim, and
   * serialising them keeps the nonce sequence and the user's mental model of
   * "N uploads, N fees" in step.
   */
  async pickAndUpload(options?: MediaPickOptions): Promise<UploadedMedia[]> {
    const picked = await pickMediaBytes();
    const descriptors: UploadedMedia[] = [];
    for (const file of picked) {
      descriptors.push(
        await this.upload({
          data: file.data,
          filename: file.filename,
          ...(options?.channelId ? { channelId: options.channelId } : {}),
        }),
      );
    }
    return descriptors;
  }
}
