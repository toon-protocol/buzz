/**
 * Soft concurrent-speaker guidance for TOON huddles (buzz#23 stage 3).
 *
 * The relay-native design has no media server to enforce a speaker cap, so
 * the limit is *soft* — measured, not configured. buzz#10's Phase F
 * multi-speaker aggregate checkpoint (toon-meta `proto/huddle-multi-speaker`,
 * RESULTS.md) is the real ADR 0003 measurement, and it came back **NO-GO**:
 * only a single speaker meets the ADR 0003 bar (99.4% of frames within
 * 150 ms); 2–3 concurrent speakers still deliver every frame but
 * increasingly late (90.6% / 73.6% within budget); at 5 the edge fails
 * outright (frames dropped on ILP-expiry, not just late). The ~140 fps
 * headroom an earlier single-session-only reading took as *per-speaker*
 * turned out to be a *global* admission ceiling shared by every session —
 * see ADR 0008, which records the fallback this result triggered. Nothing
 * breaks above the numbers — latency tails grow — so the product surface
 * stays a hint, not a gate, while huddle audio itself runs on the
 * admission+room relay (ADR 0008) rather than this TOON-native path.
 */

/** Concurrent speakers the measured envelope meets the ADR 0003 bar for (≥95% within 150ms). */
export const GUARANTEED_CONCURRENT_SPEAKERS = 1;

/** Best-effort ceiling: above this the edge measured outright failure (dropped frames, not just late ones). */
export const OPPORTUNISTIC_CONCURRENT_SPEAKERS = 3;

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
