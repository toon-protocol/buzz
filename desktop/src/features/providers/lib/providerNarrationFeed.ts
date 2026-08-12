import type { FactoryJobNarration } from "@/features/factory-jobs/lib/factoryJobFeedback";

/**
 * The provider's own §6 narration, merged from the two places it can live
 * (buzz#135, owner decision 2026-08-12: *a provider SHOULD see their own
 * narration immediately, before the relay round-trip*).
 *
 * 1. The relay read-back (`useFactoryJobFeedback`) — the same wire the buyer
 *    reads, and the only source that proves the update actually landed.
 * 2. This session's own optimistic entries, rendered the moment the provider
 *    hits send, since the round trip through a paid write plus a subscription
 *    read is far longer than a UI beat (and, in the e2e harness, never
 *    completes at all — the fake socket answers a REQ only from events seeded
 *    before it opened).
 *
 * The two are reconciled on the SIGNED EVENT ID, which the provider knows at
 * publish time because signing is local (`signRelayEvent`) and happens before
 * the write leaves the machine — so no separate correlation key has to be
 * smuggled onto the wire. An optimistic entry disappears the instant an echo
 * carrying its id arrives, which is why the id is recorded at signing time
 * rather than on publish success: a publish that times out *after* the relay
 * stored the event still dedupes against the eventual echo.
 *
 * A publish that fails is NOT silently kept looking delivered — the entry
 * stays visible but marked `failed`, so the provider can see the update did
 * not land instead of believing the buyer read it.
 *
 * Deliberately narration-only: this is about authors seeing their own writes.
 * Offers are money-bearing and stay wire-truth (their session state lives in
 * `useProviderDelivery`'s `sessionOffers`, which schedules but does not
 * render).
 */

/** How far this session's own narration got. */
export type LocalNarrationDelivery = "sending" | "sent" | "failed";

/** One narration this session published (or tried to). */
export type LocalNarration = {
  /** Render identity for the whole attempt — `RelayEvent.localKey`'s role. */
  localKey: string;
  /** The signed event's id once signing produced one; the dedupe key. */
  eventId: string | null;
  message: string;
  /** Unix seconds, so it sorts against relay `created_at` directly. */
  createdAt: number;
  delivery: LocalNarrationDelivery;
};

export type ProviderNarrationEntry = {
  /** Stable React key: the relay event id when confirmed, else the local key. */
  key: string;
  narration: string;
  createdAt: number;
  /** `confirmed` = read back off the relay; the rest are optimistic. */
  delivery: "confirmed" | LocalNarrationDelivery;
};

/**
 * Merge relay-confirmed narration with this session's optimistic entries,
 * oldest first. An optimistic entry whose signed id is already on the wire is
 * dropped — the relay copy IS that message, so it never renders twice.
 */
export function mergeOwnNarration(
  wire: FactoryJobNarration[],
  local: LocalNarration[],
): ProviderNarrationEntry[] {
  const wireEventIds = new Set(wire.map((entry) => entry.eventId));

  const confirmed: ProviderNarrationEntry[] = wire.map((entry) => ({
    key: entry.eventId,
    narration: entry.narration,
    createdAt: entry.createdAt,
    delivery: "confirmed",
  }));

  const optimistic: ProviderNarrationEntry[] = local
    .filter(
      (entry) => entry.eventId === null || !wireEventIds.has(entry.eventId),
    )
    .map((entry) => ({
      key: entry.localKey,
      narration: entry.message,
      createdAt: entry.createdAt,
      delivery: entry.delivery,
    }));

  return [...confirmed, ...optimistic].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}
