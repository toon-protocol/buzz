import * as React from "react";

import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import {
  getActiveToonTransport,
  getActiveTransportSelection,
} from "@/shared/api/transportSelection";

/**
 * The huddle cost surface (buzz#23 stage 3).
 *
 * On TOON every ~20 ms speech frame is a paid write, so joining a huddle has
 * a running cost the user must see BEFORE joining — an acceptance criterion,
 * not a nicety. The estimate shown is a *ceiling*: the connector's flat
 * per-packet fee times the maximum frame rate. The speech gate publishes
 * nothing during silence, so the real spend is usually far lower — which is
 * why every caption carries the "only while speaking" caveat rather than
 * presenting the ceiling as the price.
 *
 * Mirrors the buzz#30 composer-fee pattern (`useComposerFeeQuote`): quoted
 * once per mount, `ToonPaidWriter.quoteFee()` memoizes the route price, and
 * a failed quote never throws. Unlike the composer, the join affordances
 * *gate* on the pending state — a paid call must not be joinable before its
 * cost has had the chance to render.
 */

/**
 * Frames per minute at the wire's ceiling rate: 50 fps (one frame per 20 ms)
 * × 60 s. Continuous speech publishes at most this many paid writes a minute.
 */
export const HUDDLE_FRAMES_PER_MINUTE = 3000n;

/** What the join affordances know about the cost of speaking. */
export type HuddleFeeQuote =
  /** Relay transport — huddle audio rides the free audio room. */
  | { kind: "relay" }
  /** TOON, quote in flight — hold the join button until it lands. */
  | { kind: "pending" }
  /** TOON, quote failed — say so honestly, but do not brick joining. */
  | { kind: "unavailable" }
  /** TOON, quoted: the per-minute ceiling for continuous speech. */
  | { kind: "quoted"; perMinuteCeilingBaseUnits: bigint };

/**
 * Quote the speaking cost, never throwing. Exported apart from the hook so it
 * is unit-testable without a DOM (the `useComposerFeeQuote` precedent).
 */
export async function quoteHuddleFee(
  transport: Pick<ToonEventTransport, "quoteFee"> | null,
  isToon: boolean,
): Promise<HuddleFeeQuote> {
  if (!isToon) return { kind: "relay" };
  if (!transport) return { kind: "unavailable" };
  try {
    const perFrame = await transport.quoteFee();
    return {
      kind: "quoted",
      perMinuteCeilingBaseUnits: perFrame * HUDDLE_FRAMES_PER_MINUTE,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * The caption a join/start affordance shows for `quote`, or null when there
 * is nothing to say (the relay transport, where huddle audio is free).
 */
export function huddleCostCaption(quote: HuddleFeeQuote): string | null {
  switch (quote.kind) {
    case "relay":
      return null;
    case "pending":
      return "Checking what speaking costs…";
    case "unavailable":
      return "Speaking in a huddle is paid on this network; the rate could not be quoted.";
    case "quoted":
      return `Speaking costs up to ${formatUsdcBaseUnits(
        quote.perMinuteCeilingBaseUnits,
      )}/min — you only pay while speaking.`;
  }
}

/**
 * Whether `quote` must hold the join/start affordance closed. Only the
 * pending state gates: the cost must have had its chance to render before a
 * join (AC 4a), but a *failed* quote already rendered its honest caption —
 * blocking on it would turn a quoting hiccup into an unusable feature.
 */
export function joinGatedOnQuote(quote: HuddleFeeQuote): boolean {
  return quote.kind === "pending";
}

/** The speaking-cost quote for this run's transport, resolved once per mount. */
export function useHuddleFeeQuote(): HuddleFeeQuote {
  const isToon = getActiveTransportSelection()?.mode === "toon";
  const [quote, setQuote] = React.useState<HuddleFeeQuote>(
    isToon ? { kind: "pending" } : { kind: "relay" },
  );

  React.useEffect(() => {
    if (!isToon) return;
    let cancelled = false;
    void quoteHuddleFee(getActiveToonTransport(), isToon).then((resolved) => {
      if (!cancelled) setQuote(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [isToon]);

  return isToon ? quote : { kind: "relay" };
}
