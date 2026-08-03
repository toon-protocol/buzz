/**
 * The provider-surface freshness invariant (buzz#84, toon-meta#262 decision
 * 12): "the socket is the lease." A route exists exactly as long as the
 * authenticated connector session, so an advertisement must never claim
 * availability for longer than that session stays routable — or a buyer can
 * pay for a job that cannot land.
 *
 * Two failure directions are asymmetric and the code below only ever errs
 * toward the cheap one: reading a live provider as unavailable costs a
 * little missed work; reading an unreachable one as available costs a buyer
 * a rejected payment. A dropped session therefore reads as `stale`
 * immediately, without waiting out the lease — and going offline costs
 * reachability only, never the channel, balance, nonce position or
 * reputation (nothing here touches any of those).
 *
 * `sessionLeaseTtlMs` is a caller-supplied parameter, not a constant defined
 * here: connector#698 exports it as `SESSION_LEASE_BACKSTOP_TTL` and its own
 * doc comment says this ticket should read it from there rather than
 * duplicating the value. As of this writing that export is not yet present
 * in any published `@toon-protocol/client`/`@toon-protocol/connector`
 * release this repo can pin, so there is no live caller yet — this module is
 * ready for one once the value is available, the `agentNetworkFlow.ts`
 * precedent for shipping pure domain logic ahead of its data source.
 *
 * The refresh cadence mirrors the mesh's own reference pattern
 * (`mesh_llm/discovery.rs` `STATUS_FRESHNESS_SECS` = 120s freshness window,
 * `mesh_llm/coordinator.rs` `STATUS_PUBLISH_INTERVAL` = 45s republish) at the
 * same ~0.375 ratio, scaled to whatever lease the connector actually grants
 * rather than hardcoding either side of that ratio.
 */

/** What the provider surface knows about its own current advertisement. */
export type ProviderAvailability =
  /** The owner has not turned provider advertising on for this agent. */
  | { kind: "unadvertised" }
  /** Advertising is on, but no publish has landed yet — nothing to quote from. */
  | { kind: "pending" }
  /** Advertised, session live, and inside the connector's lease window. */
  | { kind: "available"; refreshDueAtMs: number; expiresAtMs: number }
  /** Session dropped, or the lease lapsed without a refresh — do not quote. */
  | { kind: "stale" };

/**
 * How long after publishing an advertisement to refresh it, given the
 * connector's session lease. Scaled at the mesh's own 45s/120s ratio so a
 * refresh always lands well inside the lease rather than racing its edge.
 */
export function refreshIntervalForLease(sessionLeaseTtlMs: number): number {
  return Math.floor(sessionLeaseTtlMs * (45 / 120));
}

/**
 * Derive whether this agent's provider listing is currently honest to show
 * as available, never throwing and never guessing in the buyer's favor.
 */
export function deriveProviderAvailability(input: {
  /** Whether the owner has turned provider advertising on for this agent. */
  advertisingEnabled: boolean;
  /** Whether the connector session (the lease) is currently up. */
  sessionConnected: boolean;
  /** When the advertisement was last published, or null if never. */
  lastAdvertisedAtMs: number | null;
  nowMs: number;
  /** The connector's session lease TTL — see the module doc for its source. */
  sessionLeaseTtlMs: number;
}): ProviderAvailability {
  const {
    advertisingEnabled,
    sessionConnected,
    lastAdvertisedAtMs,
    nowMs,
    sessionLeaseTtlMs,
  } = input;

  if (!advertisingEnabled) return { kind: "unadvertised" };
  if (lastAdvertisedAtMs === null) return { kind: "pending" };
  // Offline costs reachability only, and it costs it immediately — waiting
  // out the lease on a dropped session would advertise a provider that
  // cannot actually take the job.
  if (!sessionConnected) return { kind: "stale" };

  const expiresAtMs = lastAdvertisedAtMs + sessionLeaseTtlMs;
  if (nowMs >= expiresAtMs) return { kind: "stale" };

  return {
    kind: "available",
    refreshDueAtMs:
      lastAdvertisedAtMs + refreshIntervalForLease(sessionLeaseTtlMs),
    expiresAtMs,
  };
}

/**
 * Whether this agent may currently produce a paid quote (buzz#84 gotcha:
 * quoting costs money, so nothing should auto-quote outside a state that is
 * both advertised and honestly reachable right now).
 */
export function canQuoteJobs(availability: ProviderAvailability): boolean {
  return availability.kind === "available";
}

/** The caption a provider settings surface shows for each state. */
export function providerAvailabilityCaption(
  availability: ProviderAvailability,
): string | null {
  switch (availability.kind) {
    case "unadvertised":
      return null;
    case "pending":
      return "Publishing this agent's provider listing…";
    case "available":
      return "Advertised as available to buyers on the open job market.";
    case "stale":
      return "Not currently reachable — this agent's provider listing will not accept new jobs until its connector session reconnects.";
  }
}
