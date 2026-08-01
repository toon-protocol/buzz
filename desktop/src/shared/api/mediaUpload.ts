import {
  type BlobDescriptor,
  pickAndUploadMedia,
  uploadMediaBytes,
} from "@/shared/api/tauri";

/**
 * The media seam: the one place the desktop app hands attachment bytes to
 * whatever stores them.
 *
 * The sibling of `eventTransport.ts`, and for the same reason. Everything
 * upstream — the paperclip, drag-and-drop, paste, the image annotator — builds
 * bytes and a filename and stays cherry-pickable from `block/buzz`. Everything
 * downstream is backend-specific: authentication, payment, and, crucially,
 * *whether the bytes can ever be withdrawn*.
 *
 * That last difference is why the seam carries a {@link MediaUploadQuote}
 * rather than just an upload verb. Blossom media sits on the community's relay
 * and its operator can remove it; store-node media is written to Arweave and
 * cannot be removed by anyone, ever (ADR 0002). A UI that cannot tell the two
 * apart would either nag relay users about permanence that does not apply to
 * them or, far worse, let a TOON user post something irrevocable while showing
 * them a Delete button. `quote()` is how the composer learns which world it is
 * in before the first byte leaves the machine.
 */

/**
 * Thrown when the user reads the permanence disclosure and says no.
 *
 * A distinct type rather than a null return because it has to travel up
 * through the same `catch` that reports genuine upload failures, and "you
 * decided not to" is not an error to show a banner for.
 */
export class MediaUploadDeclined extends Error {
  constructor() {
    super("upload declined");
    this.name = "MediaUploadDeclined";
  }
}

/** What an upload will cost and what it commits the uploader to. */
export type MediaUploadQuote = {
  /**
   * Base units of {@link MediaUploadQuote.asset} one upload costs. Zero on a
   * free backend.
   *
   * Flat per upload, not per byte: TOON prices a route per packet, so the fee
   * is a property of the destination rather than of the file.
   */
  amount: bigint;
  /** Settlement asset code, e.g. `USDC`. */
  asset: string;
  /** Decimals for `amount` — 6 for USDC. */
  assetScale: number;
  /**
   * Whether the bytes become permanently and publicly readable.
   *
   * True means no operator, author, or court order can take them down; the only
   * available "delete" is a tombstone that asks clients to stop showing them.
   */
  permanent: boolean;
  /** Where the bytes land, for a disclosure that names the destination. */
  backend: "relay" | "store";
};

/** Bytes plus everything the backend needs to store and label them. */
export type MediaUploadRequest = {
  /** Raw file bytes, as the number array the Tauri IPC bridge speaks. */
  data: number[];
  filename?: string;
  /** Correlation id for `media-upload-progress` events from the Rust side. */
  progressId?: string;
};

/** One backend that can accept attachment bytes. */
export interface MediaUploader {
  /**
   * What one upload costs and commits to, ahead of any bytes moving.
   *
   * Async because a paid backend has to ask its connector for the route price,
   * and the answer is worth waiting for: it is the number shown in the
   * permanence disclosure.
   */
  quote(): Promise<MediaUploadQuote>;

  /** Store `request`'s bytes, resolving with a descriptor the composer can render. */
  upload(request: MediaUploadRequest): Promise<BlobDescriptor>;

  /**
   * Open a native picker and store everything chosen. Resolves empty when the
   * user cancels.
   */
  pickAndUpload(): Promise<BlobDescriptor[]>;
}

/**
 * Blossom on the community relay — the upstream backend, and the default.
 *
 * All of it already lives in Rust (`src-tauri/src/commands/media.rs`): MIME
 * sniffing, HEIC/video transcode, sanitisation, and the authenticated upload.
 * This is a shape adapter, not a reimplementation.
 */
export const relayMediaUploader: MediaUploader = {
  quote: () =>
    Promise.resolve({
      amount: 0n,
      asset: "",
      assetScale: 0,
      // The relay operator can remove a blob, so a Blossom upload makes no
      // permanence promise and must not trigger the disclosure.
      permanent: false,
      backend: "relay",
    }),
  upload: ({ data, filename, progressId }) =>
    uploadMediaBytes(data, filename, progressId),
  pickAndUpload: () => pickAndUploadMedia(),
};

let activeUploader: MediaUploader = relayMediaUploader;

/** The backend every attachment currently goes to. */
export function getMediaUploader(): MediaUploader {
  return activeUploader;
}

/** Swap the active backend. The hook a second one is installed through. */
export function setMediaUploader(uploader: MediaUploader): void {
  activeUploader = uploader;
}

/** Restore the default relay/Blossom backend. */
export function resetMediaUploader(): void {
  activeUploader = relayMediaUploader;
}

/** See {@link MediaUploader.quote}. */
export function quoteMediaUpload(): Promise<MediaUploadQuote> {
  return activeUploader.quote();
}

/** See {@link MediaUploader.upload}. */
export function uploadMediaThroughSeam(
  request: MediaUploadRequest,
): Promise<BlobDescriptor> {
  return activeUploader.upload(request);
}

/** See {@link MediaUploader.pickAndUpload}. */
export function pickAndUploadThroughSeam(): Promise<BlobDescriptor[]> {
  return activeUploader.pickAndUpload();
}
