import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import {
  getActiveToonTransport,
  getActiveTransportSelection,
} from "@/shared/api/transportSelection";

/**
 * The factory job market is TOON-native (toon-meta#262 decision 2: open
 * market on `g.toon.relay`, pay-to-write as the spam control) — it has no
 * relay-transport equivalent, unlike huddle audio (which falls back to a
 * free audio room). Mirrors the huddle fee quote's discriminated-union idiom
 * (`huddleFeeQuote.ts`) so the caller states plainly why the surface is
 * closed rather than showing an empty screen.
 */
export type FactoryJobAvailability =
  | { kind: "relay" }
  | { kind: "unavailable" }
  | { kind: "ready"; transport: ToonEventTransport };

export function factoryJobAvailability(
  transport: ToonEventTransport | null,
  isToon: boolean,
): FactoryJobAvailability {
  if (!isToon) return { kind: "relay" };
  if (!transport) return { kind: "unavailable" };
  return { kind: "ready", transport };
}

export function factoryJobAvailabilityCaption(
  availability: FactoryJobAvailability,
): string | null {
  switch (availability.kind) {
    case "relay":
      return "The factory job market runs on TOON. Switch this build's transport to TOON to post a job or browse quotes.";
    case "unavailable":
      return "The TOON transport isn't available right now — the job market can't be reached.";
    case "ready":
      return null;
  }
}

/** The active availability for this run's transport, resolved once per mount. */
export function currentFactoryJobAvailability(): FactoryJobAvailability {
  const isToon = getActiveTransportSelection()?.mode === "toon";
  return factoryJobAvailability(getActiveToonTransport(), isToon);
}

/**
 * The transport this run installed does not change mid-session (it is
 * decided once, at bootstrap — see `transportSelection.ts`), so this is a
 * plain synchronous read rather than the effect-driven resolution
 * `useHuddleFeeQuote` needs for its per-mount fee quote.
 */
export function useFactoryJobAvailability(): FactoryJobAvailability {
  return currentFactoryJobAvailability();
}
