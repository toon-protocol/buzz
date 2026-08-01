//! Relay egress guard for NIP-49 key-backup material.
//!
//! The local `ncryptsec` backup (see [`crate::key_backup`]) must NEVER be
//! transmitted to a relay. This module enforces that contract at runtime,
//! fail-closed, at every relay-bound egress boundary:
//!
//! | # | Boundary | Site | Guard call site |
//! |---|----------|------|------------------|
//! | 1 | `submit_signed_event_at_with_keys` (funnel for `submit_event*`) | `relay/submit.rs` | `event_transport::dispatch` |
//! | 2 | `sync_managed_agent_profile` | `relay.rs` | `event_transport::dispatch` |
//! | 3 | pre-signed path into the boundary-1 funnel | `relay/submit.rs` | `event_transport::dispatch` |
//! | 4 | `submit_signed_event_with_keys` | `relay.rs` | `event_transport::dispatch` |
//! | 5 | huddle STT publisher | `huddle/pipeline.rs` | locally (`sign_and_guard_stt_body`), then again in `event_transport::dispatch` |
//! | 6 | `submit_engram_event` (team snapshot) | `commands/team_snapshot.rs` (re-exported from `event_transport`) | `event_transport::dispatch` |
//! | 7 | `submit_engram_event` (persona import) | `commands/personas/snapshot/import.rs` (re-exported from `event_transport`) | `event_transport::dispatch` |
//! | 8 | native websocket send loop (all webview relay WS) | `native_websocket.rs` | locally |
//!
//! buzz#27 consolidated boundaries 1-4, 6, and 7's actual submission behind
//! `event_transport::dispatch` — the Rust-side write seam that also picks
//! between the relay and TOON-bridge transports — so their guard call now
//! lives in one place rather than one copy per site. Each boundary's own
//! function is still the thing under test below: the guard fires exactly
//! the same way whether it runs locally or inside `dispatch`.
//!
//! The inventory-completeness test in `egress_guard_tests.rs` asserts that
//! every `/events` URL-construction site in the tree calls this guard
//! (directly or via `event_transport::dispatch`), so a new submission path
//! fails the build until it is wired.
//!
//! Scope: `ncryptsec1` only. The raw `nsec` intentionally transits the
//! NIP-44-encrypted pairing session (NIP-AB payload_type "nsec"); guarding it
//! here would break pairing. Raw-key DLP is separate policy work.

/// Bech32 HRP of NIP-49 encrypted secret keys.
const NCRYPTSEC_PREFIX: &str = "ncryptsec1";
/// Bech32 also permits an ALL-UPPERCASE encoding of the same payload
/// (BIP-173); an uppercased valid backup decodes identically, so the guard
/// must reject it too. Mixed case is invalid bech32 and cannot decode — a
/// substring matching either all-lower or all-upper prefix covers every
/// decodable form.
const NCRYPTSEC_PREFIX_UPPER: &str = "NCRYPTSEC1";

/// Reject `text` if it contains NIP-49 key-backup material.
///
/// Returns `Err` when an `ncryptsec1…` (or uppercase `NCRYPTSEC1…`)
/// substring is present. Callers MUST abort the network operation on `Err` —
/// this is a fail-closed guard, not a warning.
pub fn assert_no_key_backup(text: &str, context: &'static str) -> Result<(), String> {
    if text.contains(NCRYPTSEC_PREFIX) || text.contains(NCRYPTSEC_PREFIX_UPPER) {
        return Err(format!(
            "blocked {context}: payload contains NIP-49 key-backup material \
             (ncryptsec); the local key backup must never be transmitted to a relay"
        ));
    }
    Ok(())
}

/// Byte-slice variant for callers that hold serialized bodies.
pub fn assert_no_key_backup_bytes(body: &[u8], context: &'static str) -> Result<(), String> {
    // ncryptsec is ASCII bech32; a UTF-8-lossy view preserves any occurrence.
    assert_no_key_backup(&String::from_utf8_lossy(body), context)
}

#[cfg(test)]
#[path = "egress_guard_tests.rs"]
mod tests;
