/**
 * Soft concurrent-speaker guidance for TOON huddles (buzz#23 stage 3).
 *
 * The relay-native design has no media server to enforce a speaker cap, so
 * the limit is *soft* — measured, not configured. The Phase I sizing runs
 * (toon-meta `proto/huddle-multi-speaker`, 2026-08-02) put the devnet edge
 * at: every session ≥95% of frames within 150 ms up to 3 concurrent
 * speakers (the ADR 0003 bar, passed 3/3 runs), degrading but often usable
 * up to ~10 (mixed results), failing beyond. Nothing breaks above the
 * numbers — latency tails grow — so the product surface is a hint, not a
 * gate.
 */

/** Concurrent speakers the measured envelope guarantees (ADR 0003 bar met). */
export const GUARANTEED_CONCURRENT_SPEAKERS = 3;

/** Best-effort ceiling: above this the edge measured outright failure. */
export const OPPORTUNISTIC_CONCURRENT_SPEAKERS = 10;

/**
 * The hint to show for `activeSpeakerCount` people speaking at once, or null
 * when there is nothing to warn about. TOON-only: the relay audio room mixes
 * through the community relay and has its own (server-side) limits.
 */
export function speakerLoadHint(
  activeSpeakerCount: number,
  isToon: boolean,
): string | null {
  if (!isToon) return null;
  if (activeSpeakerCount <= GUARANTEED_CONCURRENT_SPEAKERS) return null;
  if (activeSpeakerCount <= OPPORTUNISTIC_CONCURRENT_SPEAKERS) {
    return `${activeSpeakerCount} people are speaking — audio may degrade above ${GUARANTEED_CONCURRENT_SPEAKERS} concurrent speakers.`;
  }
  return `${activeSpeakerCount} people are speaking — audio degrades sharply above ${OPPORTUNISTIC_CONCURRENT_SPEAKERS} concurrent speakers.`;
}
