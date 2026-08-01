import { arweaveMediaUrls } from "@/shared/lib/arweaveMedia";
import {
  MediaUploadUnavailable,
  type MediaUploader,
  type MediaUploadQuote,
  type MediaUploadRequest,
} from "@/shared/api/mediaUpload";
import { pickMediaBytes } from "@/shared/api/tauriMedia";
import type { BlobDescriptor } from "@/shared/api/tauri";
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

/** Lowercase hex SHA-256 of `data`, the identity Nostr `imeta` records as `x`. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  // Copy into a fresh buffer rather than slicing `data.buffer`: the source may
  // be a view onto a SharedArrayBuffer, which WebCrypto does not accept.
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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

  async upload({
    data,
    filename,
  }: MediaUploadRequest): Promise<BlobDescriptor> {
    if (data.length === 0) throw new Error("empty upload");

    // Quote before hashing, not just before paying: an unpriced route must
    // refuse the upload outright, and there is no reason to spend time on
    // bytes that are not going anywhere.
    await this.quote();

    const bytes = Uint8Array.from(data);
    const contentType = detectContentType(data, filename);
    const [sha256, dim] = await Promise.all([
      sha256Hex(bytes),
      measureImage(bytes, contentType),
    ]);

    const { txId } = await this.writer.uploadBlob(bytes, contentType);
    // Every gateway serves the same bytes, so the descriptor carries the
    // locally-preferred one. Readers re-derive the rest from the tx id in the
    // URL (`arweaveMediaCandidates`), which is why no `fallback` list has to
    // survive the imeta round-trip for fallover to work on the other client.
    const { url } = arweaveMediaUrls(txId);

    return {
      url,
      sha256,
      size: bytes.byteLength,
      type: contentType,
      uploaded: Math.floor(Date.now() / 1000),
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
  async pickAndUpload(): Promise<BlobDescriptor[]> {
    const picked = await pickMediaBytes();
    const descriptors: BlobDescriptor[] = [];
    for (const file of picked) {
      descriptors.push(
        await this.upload({ data: file.data, filename: file.filename }),
      );
    }
    return descriptors;
  }
}
