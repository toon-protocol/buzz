import * as React from "react";

import {
  getActiveToonTransport,
  getActiveTransportSelection,
} from "@/shared/api/transportSelection";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";

/**
 * Quote the everyday composer's per-message fee (buzz#30), or resolve to
 * null when there is nothing to show.
 *
 * Exported apart from {@link useComposerFeeQuote} so it is unit-testable
 * without mounting React — this codebase's unit tests run under plain
 * `node:test` with no DOM (see `MessageComposerAutoSend.test.mjs`'s header
 * comment). A mocked `quoteFee` and an `isToon` flag are enough to exercise
 * every branch: a priced toon route, a toon route whose quote fails, and
 * relay mode, where the transport — even if one is passed — is never asked.
 *
 * Never throws: a route that cannot be quoted (no channel yet, connector
 * down, unpriced route) is not a reason to block the composer. The
 * unpriced-route hard-stop belongs to the media-upload seam
 * (`ToonPaidWriter.quoteStoreFee`, buzz#44) — a paid write with nothing to
 * upload, this is not that seam, and a failed quote here must never stop a
 * send.
 */
export async function quoteComposerFee(
  transport: Pick<ToonEventTransport, "quoteFee"> | null,
  isToon: boolean,
): Promise<bigint | null> {
  if (!isToon || !transport) return null;
  try {
    return await transport.quoteFee();
  } catch {
    return null;
  }
}

/**
 * The everyday composer's per-message fee, in base units — visible only when
 * `BUZZ_TRANSPORT=toon`, and null (hidden) on the relay transport or whenever
 * the quote fails.
 *
 * Quoted once, when this hook mounts on a TOON transport — not on every
 * keystroke. `ToonPaidWriter.quoteFee()` already memoizes the route price for
 * the writer's lifetime (`toonPaidWriter.ts`'s `routePrice` field), so a
 * second composer mounting elsewhere (thread panel, forum) resolves from that
 * cache rather than re-asking the connector, and this hook never needs its
 * own polling loop or keystroke-driven re-quote.
 */
export function useComposerFeeQuote(): bigint | null {
  const isToon = getActiveTransportSelection()?.mode === "toon";
  const [feeBaseUnits, setFeeBaseUnits] = React.useState<bigint | null>(null);

  React.useEffect(() => {
    if (!isToon) return;
    let cancelled = false;
    void quoteComposerFee(getActiveToonTransport(), isToon).then((amount) => {
      if (!cancelled) setFeeBaseUnits(amount);
    });
    return () => {
      cancelled = true;
    };
  }, [isToon]);

  return isToon ? feeBaseUnits : null;
}
