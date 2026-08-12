---
status: accepted
---

# Huddle multi-speaker aggregate validation failed; fall back to the admission+room design

ADR 0003 conditioned the relay-native BTP huddle design on a checkpoint it explicitly deferred: only single-session throughput (~140fps headroom at 50fps offered) had been measured, and multi-speaker aggregate load — N concurrent sessions, each a real speaker — was extrapolated, not proven. buzz#10 ran that checkpoint against the live devnet edge (toon-meta branch `proto/huddle-multi-speaker`, `prototypes/huddle-over-ilp/RESULTS.md` § "Phase F — multi-speaker aggregate", harness `multi.mjs`).

**ADR 0003's bar: ≥95% of each speaker's frames delivered within 150ms, per session, at N=3. Measured: 73.6%. NO-GO.**

| N | offered (aggregate) | delivered | within 150ms |
|---|---|---|---|
| 1 (control) | 47.2 fps | 100% | 99.4% |
| 2 | 94.6 fps | 100% | 90.6% |
| 3 (the bar) | 141.9 fps | 100% | 73.6% |
| 5 | 236.4 fps | 97.4% | 0.1% (372 ILP prepare-expiry failures) |

The ~140fps single-session headroom Phase D measured is a **global** admission ceiling, not a per-session one: neither the relay nor the connector is CPU-saturated at N=5 (relay ~69%, connector ~13%), so the pipeline itself won't admit past ~140–150fps in aggregate regardless of how many sessions offer it. Five speakers don't get 5× that headroom; they share one ~140fps pipe, and the excess becomes an unbounded queue that grows until frames hit the 30s ILP prepare expiry. The failure mode is delay, not loss, until that expiry: zero nginx 503s and zero claim-nonce rejects at any N. Full numbers, per-run stats, and CPU profiling live in buzz#10's measurement comment and the linked RESULTS.md section.

Per ADR 0003's own fallback trigger ("if aggregate validation fails, fall back to the admission+room design"), huddle audio stays on the WebSocket Opus admission+room relay already built into `buzz-relay` (`src/audio/`) — see ARCHITECTURE.md § "Huddle Audio — WebSocket Opus Relay". No migration of huddle audio to BTP-native frames proceeds until the gaps below are closed and re-validated.

## Considered options

- **Ship BTP huddles at N=3 anyway, accept degraded playout above 2 speakers**: rejected — 73.6% is far below the 95% bar, and the failure mode (multi-second stalls draining over 10–20s) is worse for a live call than a hard admission cap would be.
- **Re-architect BTP now (claim batching + admission control) before shipping anything**: the eventual right fix (see Consequences), but it is new relay/connector work with its own validation cycle and does not unblock huddles today.
- **Fall back to the existing admission+room design** (chosen): already built, already the documented current huddle experience (ARCHITECTURE.md, VISION.md), no new dependencies, no further validation needed to keep using it.

## Consequences

- buzz#6's BTP dependencies (connector#680 merging, `@toon-protocol/client` productizing BTP paid writes) are no longer on the critical path for shipping huddles; huddle work proceeds on the existing WebSocket admission+room relay.
- buzz#23 (Desktop huddles v1) is unblocked to build against the admission+room design it already runs on; its acceptance criteria referencing BTP frame delivery "per ADR 0003" need re-scoping in that issue, not here.
- `desktop/src/features/huddle/lib/speakerLoad.ts`'s soft concurrent-speaker hint (TOON-native path only) is corrected to the real envelope: guaranteed at 1 speaker, opportunistic up to 3, sharply degraded beyond — replacing an earlier, more optimistic reading that had claimed the N=3 bar passed.
- A future BTP migration for huddle audio remains possible but needs, per buzz#10's findings, before it can be re-validated: (1) a connector/relay profiling ticket for the ~150fps global admission ceiling (it is not CPU-bound — a serialization point, per-connection or per-relay-write ordering); (2) claim-aggregated frame batching (~5 frames / 100ms per packet) so offered packet rate drops 5× and would fit 3 speakers under today's ceiling with the playout budget intact; (3) a bounded per-room admitted-speaker cap with local frame-dropping (never queueing) instead of the current unbounded send. None of these are scheduled work as of this ADR.
