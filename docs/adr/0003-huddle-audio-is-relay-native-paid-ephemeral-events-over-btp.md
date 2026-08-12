---
status: superseded
superseded_by: 0008
---

# Huddle audio is relay-native paid ephemeral events over BTP

> **Superseded 2026-08-10** — the multi-speaker aggregate validation this ADR's
> Consequences section required came back NO-GO (buzz#10: 73.6% of frames
> delivered within 150ms at N=3, against the ≥95% bar). The fallback trigger
> below fired; huddle audio stays on the admission+room design. See
> [ADR 0008](0008-huddle-multi-speaker-validation-failed-fallback-to-admission-room.md)
> for the measurement and the re-plan. The rest of this document is kept as
> the record of the single-session decision it was — accurate as far as it
> went, just not sufficient.

Live huddle audio is not a media server: each ~20ms Opus frame is a dust-priced ephemeral paid write published over the connector's BTP websocket ingress, and listeners receive frames via free relay subscriptions (the relay is the fan-out). This was decided on measurement, not theory — live devnet, phases A–E plus a BTP rerun (toon-meta branch `proto/huddle-over-ilp`, RESULTS.md, final commit c489523): at 50 frames/sec paced, BTP delivered 100% of frames with 99.3% inside the 150ms playout budget, zero refusals, ~140fps per-session headroom; the ordered BTP session structurally eliminates claim-nonce races, and BTP frames bypass per-request HTTP rate limiting. At an operator-set 1 micro-USDC/frame, audio costs ~0.003 USDC per speaker-minute.

## Considered options

- **STREAM (RFC 29) over ILP**: no implementation exists in the stack, ordered-only delivery is wrong for live audio, and it is point-to-point (no fan-out); rejected.
- **Paid admission + payment-oblivious WebSocket Opus room**: the conservative design; works on any edge but builds a room service the measurements show is unnecessary. Kept as the documented fallback.

## Consequences

Three dependencies ride with this: the connector BTP client ingress must merge (toon-protocol/connector#680), `@toon-protocol/client` must productize BTP paid writes, and multi-speaker aggregate load (N×50fps across sessions) must be validated early — only single-session throughput is proven. Huddles require an edge whose operator prices ephemeral frames at dust (the community's own relay in the one-community-one-relay model). Revisit: if aggregate validation fails, fall back to the admission+room design.
