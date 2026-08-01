/**
 * Rendering permaweb media: which gateway to ask, and what to ask next when
 * that one is down.
 *
 * Media on TOON lives on Arweave (ADR 0002), addressed by a 43-character
 * transaction id. Gateways are interchangeable mirrors of the same
 * content-addressed bytes, so a failed image load is an availability problem
 * with one host, never a missing file — the right response is to try the next
 * gateway, not to show a broken image.
 *
 * The gateway list itself is NOT owned here. `@toon-protocol/arweave` is the
 * single source of truth shared with the rest of the TOON stack (the client
 * daemon stamps upload mirrors from the same list), so this module is a thin
 * adapter over it: it holds the app's *configured* override and forwards.
 */

import {
  ARWEAVE_GATEWAYS,
  arweaveGatewayCandidates,
  arweaveTxId,
  arweaveUrls,
} from "@toon-protocol/arweave";

/**
 * The configured gateway preference, or null for "use the shared default".
 *
 * Module state rather than a parameter on every call because the consumers are
 * deep in the render tree (`<img>` error handlers) where threading transport
 * configuration down would mean touching every intermediate component. Set
 * once at transport install, same lifecycle as the transport itself.
 */
let configuredGateways: readonly string[] | null = null;

/**
 * Install the gateway preference list, or clear it with `null`/`[]`.
 *
 * An empty list clears rather than disables: no gateways means no media, which
 * is never what a misconfigured environment variable should produce.
 */
export function setArweaveGateways(gateways: readonly string[] | null): void {
  configuredGateways = gateways && gateways.length > 0 ? [...gateways] : null;
}

/** The gateway list in effect — the configured override, else the shared default. */
export function getArweaveGateways(): readonly string[] {
  return configuredGateways ?? ARWEAVE_GATEWAYS;
}

/** Whether `url` addresses Arweave content (and so has interchangeable mirrors). */
export function isArweaveMediaUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && arweaveTxId(url) !== null;
}

/**
 * Every URL worth trying for `url`, best first.
 *
 * A non-Arweave URL yields just itself, so callers can use this unconditionally
 * instead of branching on the URL's origin. `extraFallbacks` carries mirrors the
 * publisher supplied in NIP-92 `fallback` fields, which are appended after the
 * locally-preferred gateways: our list reflects what *this* client can reach.
 */
export function arweaveMediaCandidates(
  url: string,
  extraFallbacks: string[] = [],
): string[] {
  return arweaveGatewayCandidates(url, extraFallbacks, getArweaveGateways());
}

/**
 * The primary URL and mirror list to stamp on a freshly-uploaded blob.
 *
 * The primary goes in `imeta url` (and the message body), the mirrors in
 * `imeta fallback`, so a client with a different gateway preference than ours
 * still has somewhere to go.
 */
export function arweaveMediaUrls(txId: string): {
  url: string;
  fallbacks: string[];
} {
  return arweaveUrls(txId, getArweaveGateways());
}

/**
 * Advance past `failedUrl` in the candidate list for `originalUrl`.
 *
 * Returns the next gateway to try, or null once every mirror has failed. Pure,
 * so the rotation is testable without a DOM: the `<img>` error handler only has
 * to remember which URL just failed.
 */
export function nextArweaveGatewayUrl(
  originalUrl: string,
  failedUrl: string,
  extraFallbacks: string[] = [],
): string | null {
  const candidates = arweaveMediaCandidates(originalUrl, extraFallbacks);
  const failedIndex = candidates.indexOf(failedUrl);
  if (failedIndex === -1) {
    // The failure was on a URL we never proposed (a relay-proxied rewrite, an
    // already-exhausted rotation). Restarting from the top would loop forever.
    return null;
  }
  return candidates[failedIndex + 1] ?? null;
}
