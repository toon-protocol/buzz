import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decryptIncrementArtifact } from "@toon-protocol/rig";

import {
  arweaveMediaCandidates,
  arweaveMediaUrls,
  isArweaveMediaUrl,
} from "@/shared/lib/arweaveMedia";

/**
 * The buyer's decrypt tail (buzz#135): once `payFactoryJobIncrement` has
 * settled and the FULFILL's preimage is in hand, the paid artifact is only
 * a fetch and a decrypt away — the offer's `i` url tag names where the
 * ciphertext permanently lives, and the fulfillment IS the key (§4.2 of
 * `docs/factory-job-protocol.md`, toon-meta).
 *
 * Both integrity checks the wire offers are enforced, in order:
 * - the offer's ciphertext-sha256 `i` hash tag (when present) catches a
 *   corrupted or wrong gateway fetch BEFORE any decryption is attempted;
 * - `decryptIncrementArtifact` is condition-checked — a provider who
 *   revealed a different key than the `condition` tag advertised is caught
 *   rather than trusted (`@toon-protocol/rig`'s own contract).
 */

export class FactoryJobArtifactError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FactoryJobArtifactError";
  }
}

/**
 * Every URL worth trying for an offer's artifact reference, best first. The
 * `i` url tag carries a bare Arweave tx id per §4.1, but a full gateway URL
 * is tolerated the same way media rendering tolerates either
 * (`arweaveMedia.ts` — the gateways are interchangeable mirrors of the same
 * content-addressed bytes).
 */
export function artifactUrlCandidates(artifactRef: string): string[] {
  if (isArweaveMediaUrl(artifactRef)) {
    return arweaveMediaCandidates(artifactRef);
  }
  const { url, fallbacks } = arweaveMediaUrls(artifactRef);
  return [url, ...fallbacks];
}

/**
 * Fetch the ciphertext behind an offer's artifact reference, trying each
 * gateway in preference order — a failed gateway is an availability problem
 * with one host, never a missing file. When `expectedSha256Hex` (the offer's
 * `i` hash tag) is given, a candidate whose bytes do not hash to it is
 * treated as a bad fetch and the next gateway is tried.
 */
export async function fetchFactoryJobCiphertext(
  artifactRef: string,
  options: {
    expectedSha256Hex?: string | null;
    /** Injection point for tests; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const expected = options.expectedSha256Hex?.toLowerCase() ?? null;
  let lastFailure: unknown = null;

  for (const url of artifactUrlCandidates(artifactRef)) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        lastFailure = new Error(`${url} answered ${response.status}`);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (expected !== null && bytesToHex(sha256(bytes)) !== expected) {
        lastFailure = new Error(
          `${url} served bytes that do not match the offer's ciphertext hash`,
        );
        continue;
      }
      return bytes;
    } catch (error) {
      lastFailure = error;
    }
  }

  throw new FactoryJobArtifactError(
    "Couldn't fetch the encrypted artifact from any Arweave gateway.",
    { cause: lastFailure },
  );
}

/**
 * Decrypt a fetched ciphertext with the stored payment fulfillment — the
 * ONLY key material the buyer ever holds (no side channel). Condition-
 * checked: `offerConditionHex` must be the offer's own `condition` tag as
 * read off the relay before payment, so a wrong or substituted key throws
 * instead of decrypting garbage.
 */
export function decryptFactoryJobArtifact(
  ciphertext: Uint8Array,
  fulfillmentHex: string,
  offerConditionHex: string,
): Uint8Array {
  try {
    return decryptIncrementArtifact(
      ciphertext,
      hexToBytes(fulfillmentHex),
      offerConditionHex,
    );
  } catch (error) {
    throw new FactoryJobArtifactError(
      "The stored payment fulfillment does not decrypt this artifact — the ciphertext or key does not match the offer's condition.",
      { cause: error },
    );
  }
}

/** A decrypted artifact, decoded for display when it is text. */
export type FactoryJobArtifactContent =
  | { kind: "text"; text: string }
  | { kind: "binary"; byteLength: number };

/** One paid increment's progress through the fetch-then-decrypt tail above. */
export type PaidArtifactState =
  | { kind: "loading" }
  | { kind: "ready"; content: FactoryJobArtifactContent }
  | { kind: "error"; message: string };

/**
 * Decode an artifact for the thread. Providers on this surface deliver
 * text (the delivery form is a text input), but the wire allows any bytes —
 * a non-UTF-8 artifact reports its size rather than mojibake.
 */
export function describeFactoryJobArtifact(
  bytes: Uint8Array,
): FactoryJobArtifactContent {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "text", text };
  } catch {
    return { kind: "binary", byteLength: bytes.byteLength };
  }
}
