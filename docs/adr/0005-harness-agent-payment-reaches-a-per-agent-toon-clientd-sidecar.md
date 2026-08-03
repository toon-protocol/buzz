---
status: accepted
---

# Harness agent payment reaches a per-agent `toon-clientd` sidecar

`buzz-acp` pays for TOON writes the same way `buzz-cli`'s existing agent-members (search indexer, workflow runner) already do: it holds no mnemonic and no TOON private key itself, and instead reaches a `toon-clientd` sidecar over HTTP (`--toon-sidecar-url` / `TOON_DAEMON_URL`, `BUZZ_TRANSPORT=toon`). The daemon is the identity custodian — it derives the agent's payment key from the owner's seed at a configured `BUZZ_TOON_ACCOUNT_INDEX`, opens or resumes that agent's payment channel, and signs and pays for every write from it. **One `toon-clientd` daemon per agent identity** — never a shared multi-identity daemon, never an in-process payment client embedded in `buzz-acp` itself.

This is the payment-path topology decision buzz#73 owns, ahead of buzz#79 multiplying it by N agents.

## Considered options

- **In-process payment client inside `buzz-acp`**: rejected — no embeddable Rust TOON/ILP payment client exists anywhere in this stack (confirmed by grep across every workspace `Cargo.toml`). Desktop's own Rust `EventTransport` (`desktop/src-tauri/src/event_transport/mod.rs`, buzz#27) hits the identical wall for its TOON arm and works around it by bridging to the frontend's already-live TS client in a webview (`BridgeTransport`) — a bridge that does not exist for a headless harness with no window. Building a native Rust TOON client is out of scope for proving one agent can pay.
- **One shared multi-identity daemon fronting N agents**: rejected — `toon-clientd`'s `/status` and `/publish-unsigned` are single-identity by shape (one `identity` in the status envelope, no per-request identity selector). Multiplexing identities inside the daemon is new daemon-side engineering with no precedent in this repo, and would need to be built and hardened before buzz#79 could rely on it.
- **Daemon per agent, addressed by URL** (chosen): zero new payment-client engineering — it is exactly `buzz-cli`'s `sidecar.rs` pattern, already proven live by `search_agent` and `workflow_agent`. `buzz-acp` sends an unsigned event shell (kind, content, tags) to `POST /publish-unsigned`; the sidecar signs with its own held key and pays from its own channel. Payer and signer stay the same identity by construction — the harness never needs to reconcile a "who signed" with a "who paid" pair.

## Consequences

Running a fleet of N `buzz-acp` agents on TOON means running N `toon-clientd` daemons (or 1:1 daemon-per-identity pairs), each independently funded, each independently opening/resuming its own channel — buzz#79's job is to formalize that spawn/registry wiring, not to revisit this shape. `buzz-acp`'s new `crates/buzz-acp/src/toon.rs` module implements the transport seam (`EventTransport::{Relay, Toon}`, mirroring the shape of desktop's Rust `EventTransport`) so a write never grows a second ad-hoc publish path; the first caller ported to it is `pool::post_failure_notice`. Ephemeral chatter (presence, typing) is unaffected — ADR 0001 already scopes those out of TOON v1, so this ticket's "pay per write" surface is exactly the writes that persist. Any funding step for a newly provisioned sidecar must verify balance deltas rather than trust the devnet faucet's response (toon-protocol/connector#691 — the Solana faucet leg can report success with zero lamports delivered).
