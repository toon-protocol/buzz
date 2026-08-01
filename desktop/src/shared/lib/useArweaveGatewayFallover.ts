import * as React from "react";

import { nextArweaveGatewayUrl } from "@/shared/lib/arweaveMedia";

/**
 * Keep a permaweb image rendering when a gateway is down.
 *
 * Arweave content is mirrored across interchangeable gateways, so an `<img>`
 * error on one of them says nothing about whether the file exists — the right
 * response is to ask the next gateway, and only give up once every mirror has
 * refused. Without this, one flaky gateway shows a broken image for content
 * that is, by construction, permanently available somewhere else.
 *
 * Non-Arweave sources pass straight through: the hook is safe to apply to every
 * image rather than only the ones a caller believes are on the permaweb.
 *
 * @param src - The URL the renderer resolved. Changing it restarts the rotation.
 * @returns The URL to render, and the error handler that advances it.
 */
export function useArweaveGatewayFallover(src: string | undefined): {
  src: string | undefined;
  onError: () => void;
} {
  const [override, setOverride] = React.useState<string | null>(null);

  // A new source is a new rotation. Tracking the source in state (rather than
  // resetting from an effect) means the very first render after `src` changes
  // already shows the new image, with no frame of the stale override.
  const [rotatedFrom, setRotatedFrom] = React.useState(src);
  if (rotatedFrom !== src) {
    setRotatedFrom(src);
    setOverride(null);
  }

  const current = override ?? src;

  const onError = React.useCallback(() => {
    if (!src || !current) return;
    const next = nextArweaveGatewayUrl(src, current);
    // Null means either "not permaweb content" or "every mirror failed".
    // Both leave the last attempt in place so the browser's own broken-image
    // treatment is what the user sees, rather than a silent blank.
    if (next !== null) setOverride(next);
  }, [current, src]);

  return { src: current, onError };
}
