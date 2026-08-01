//! The Rust-side write seam (buzz#27).
//!
//! Mirrors `shared/api/eventTransport.ts` on the frontend (buzz#9/#11): the
//! one place a signed event is handed to whatever carries it to the network.
//! Before this module, `relay::submit_event*` was the closest thing Rust had
//! to a chokepoint, but four more sites hand-rolled the identical NIP-98
//! `POST /events` themselves — `relay::sync_managed_agent_profile`, the
//! managed-agent snapshot importers in `commands::personas::snapshot::import`
//! and `commands::team_snapshot`, and the huddle STT pipeline in
//! `huddle::pipeline`. A second transport had five places to cover instead
//! of one, and tag-bearing channel messages (threading/media/emoji), which
//! DO go through `submit_event*`, still landed on the relay path even after
//! the frontend switched to TOON.
//!
//! Every one of those callers now builds a [`SignedEventSubmission`] and
//! calls [`dispatch`], which:
//! 1. runs the egress guard exactly once, regardless of which transport is
//!    chosen — a write that never reaches a network must still never carry
//!    key-backup material to whichever one it *would* have reached;
//! 2. picks an [`EventTransport`] by [`transport_mode`], the same
//!    `BUZZ_TRANSPORT` switch the frontend seam reads; and
//! 3. delegates the actual submission to it.
//!
//! The unit of exchange is already-signed, already-serialized event bytes
//! (`event.as_json()`), not a typed `nostr::Event`. Different corners of the
//! tree sign with different `nostr`-adjacent builders (the engram/profile
//! helpers bridge through `buzz_sdk_pkg`), and bytes are the one
//! representation every signer already produces — the seam never has to
//! agree on a type, only on wire format. Callers that need the event's own
//! id keep it from the `nostr::Event` they held before serializing; the seam
//! itself never needs to parse it back out except cosmetically (see
//! `bridge::extract_event_id`).
//!
//! ## The two implementations
//!
//! [`RelayHttpTransport`] is the default: the NIP-98 authenticated HTTP POST
//! to `/events` buzz has always used, extracted rather than reinvented.
//!
//! [`BridgeTransport`] is the pragmatic v1 for TOON. Rust has no payment
//! client of its own — paying for a write is entirely a TS concern
//! (`toonPaidWriter.ts`), and reimplementing ILP-over-HTTP in Rust to cover
//! four call sites is not a trade worth making. Instead the signed event is
//! handed to the frontend's already-active `getEventTransport()` — the very
//! seam TS writes use — over a Tauri event, and the frontend reports
//! accept/reject back. See `bridge` for the full contract and its known
//! limitations.

mod bridge;
mod relay_http;

pub(crate) use bridge::resolve_pending;
pub use bridge::BridgeTransport;
pub use relay_http::RelayHttpTransport;

use crate::app_state::AppState;
use crate::relay::SubmitEventResponse;

/// Everything needed to submit one already-signed event, transport-agnostic.
pub struct SignedEventSubmission<'a> {
    /// The exact request body: `event.as_json().into_bytes()`.
    pub body: &'a [u8],
    /// Full `.../events` URL at the relay path.
    ///
    /// The bridge transport ignores this: its destination is whatever the
    /// frontend's active `ToonTransportConfig` publishes to, not the
    /// caller's target relay, so an explicit non-workspace relay (e.g. a
    /// managed agent's `relay_url` pin, or a snapshot restore's original
    /// relay) cannot be honoured while TOON is active. Known v1 limitation —
    /// see `bridge`'s doc comment.
    pub api_url: String,
    /// NIP-98 identity the request authenticates as.
    pub keys: &'a nostr::Keys,
    /// NIP-OA auth tag header, when the caller has one.
    pub auth_tag: Option<&'a str>,
    /// Egress-guard label naming this boundary in its error text.
    pub context: &'static str,
}

/// Which implementation of the seam carries the app's writes.
///
/// Mirrors `toonTransportConfig.parseTransportMode` on the frontend: `relay`
/// unless the environment explicitly asks for `toon`, so an unrecognised
/// value degrades to the transport every build already runs rather than to a
/// broken one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportMode {
    Relay,
    Toon,
}

fn parse_transport_mode(value: Option<&str>) -> TransportMode {
    match value {
        Some(v) if v.eq_ignore_ascii_case("toon") => TransportMode::Toon,
        _ => TransportMode::Relay,
    }
}

/// Read `BUZZ_TRANSPORT` the same way the frontend does.
pub fn transport_mode() -> TransportMode {
    parse_transport_mode(crate::relay::configured_env_var("BUZZ_TRANSPORT").as_deref())
}

/// The seam's contract: submit an already-signed event and resolve once the
/// transport confirms the write, or reject with a reason a caller can
/// surface. Never drop a write silently.
#[async_trait::async_trait]
pub trait EventTransport: Send + Sync {
    async fn submit(
        &self,
        state: &AppState,
        submission: SignedEventSubmission<'_>,
    ) -> Result<SubmitEventResponse, String>;
}

/// The seam entry point. Every hand-rolled `POST /events` in the tree — and
/// the `submit_event*` family that already funnelled most of them — goes
/// through here.
pub async fn dispatch(
    state: &AppState,
    submission: SignedEventSubmission<'_>,
) -> Result<SubmitEventResponse, String> {
    crate::egress_guard::assert_no_key_backup_bytes(submission.body, submission.context)?;
    match transport_mode() {
        TransportMode::Relay => RelayHttpTransport.submit(state, submission).await,
        TransportMode::Toon => BridgeTransport.submit(state, submission).await,
    }
}

/// Shared implementation behind `submit_engram_event`, re-exported under that
/// name from `commands::personas::snapshot::import` and
/// `commands::team_snapshot`. Until buzz#27 these were two hand-rolled,
/// near-identical `POST /events` call sites — each with its own copy of the
/// egress guard call — restoring an agent's memory engrams during a persona
/// or team snapshot import; now both just ask the seam.
///
/// Takes a pre-built, full submission URL rather than a relay base, unlike
/// most other callers of [`dispatch`]: a snapshot restore resolves its
/// target relay (which may not be the current workspace relay — an agent can
/// carry a `relay_url` pin from where it was originally created) before the
/// event is even built, so the caller already has the exact URL in hand.
pub(crate) async fn submit_engram_event(
    state: &AppState,
    agent_keys: &nostr::Keys,
    event_json: &[u8],
    url: &str,
    auth_tag: Option<&str>,
) -> Result<(), String> {
    dispatch(
        state,
        SignedEventSubmission {
            body: event_json,
            api_url: url.to_string(),
            keys: agent_keys,
            auth_tag,
            context: "managed-agent engram submit",
        },
    )
    .await
    .map(|_| ())
    .map_err(|msg| format!("relay rejected engram: {msg}"))
}

#[cfg(test)]
mod tests {
    use super::{parse_transport_mode, TransportMode};

    // Pure-function tests only: `transport_mode()` itself reads process
    // environment, which tests must not mutate (the binary's test harness
    // shares one process — see `transport.rs`'s equivalent tests).

    #[test]
    fn defaults_to_relay_when_unset() {
        assert_eq!(parse_transport_mode(None), TransportMode::Relay);
    }

    #[test]
    fn recognises_toon_case_insensitively() {
        assert_eq!(parse_transport_mode(Some("toon")), TransportMode::Toon);
        assert_eq!(parse_transport_mode(Some("TOON")), TransportMode::Toon);
        assert_eq!(parse_transport_mode(Some("ToOn")), TransportMode::Toon);
    }

    #[test]
    fn trims_are_the_callers_job_not_this_functions() {
        // configured_env_var() already trims before this function ever sees
        // the value; a caller that skips it gets exactly what it passed.
        assert_eq!(parse_transport_mode(Some(" toon ")), TransportMode::Relay);
    }

    #[test]
    fn unrecognised_value_falls_back_to_relay() {
        assert_eq!(parse_transport_mode(Some("bogus")), TransportMode::Relay);
        assert_eq!(parse_transport_mode(Some("relay")), TransportMode::Relay);
        assert_eq!(parse_transport_mode(Some("")), TransportMode::Relay);
    }

    // ── Channel-key sealing reaches this boundary already done (buzz#33) ──
    //
    // `dispatch` never inspects `submission.body` beyond the egress guard —
    // by the time any caller reaches it, the seam's module doc already
    // states the contract: "already-signed, already-serialized event bytes
    // (`event.as_json()`)". For a channel-scoped event this crate builds
    // (`events::build_message` and friends), that string is exactly what
    // `send_channel_message`/`submit_event`/`relay::submit.rs` hand to
    // `dispatch` as `SignedEventSubmission::body`. This test does not spin up
    // a transport (the pure-function-tests constraint above still applies:
    // no env mutation, no network): it proves the sealing seam lives fully
    // upstream of the boundary by inspecting that exact byte string for a
    // keyed channel, the same substitution `send_channel_message` performs
    // before it ever calls `submit_event`.
    #[test]
    fn a_keyed_channel_message_never_reaches_the_dispatch_boundary_as_plaintext() {
        use crate::channel_keys::{self, channel_keys_test_lock, ChannelKey, CHANNEL_KEY_BYTES};
        use nostr::JsonUtil;
        use std::collections::HashMap;

        let _guard = channel_keys_test_lock();
        let channel = uuid::Uuid::new_v4();
        let key: ChannelKey = [0x7a; CHANNEL_KEY_BYTES];
        let mut entries = HashMap::new();
        entries.insert(channel.to_string(), hex::encode(key));
        channel_keys::sync_keys(entries);

        let builder = crate::events::build_message(
            channel,
            "the deploy password is hunter2",
            None,
            &[],
            &[],
            &[],
            &[],
        )
        .expect("build keyed channel message");
        let event = builder
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign keyed channel message");

        // Exactly `SignedEventSubmission::body` for this event, on either
        // transport.
        let body = event.as_json().into_bytes();
        let body_text = String::from_utf8(body).expect("event JSON is UTF-8");

        assert!(
            !body_text.contains("hunter2"),
            "plaintext reached the dispatch boundary: {body_text}"
        );
        assert!(body_text.contains("\"encrypted\""));
        assert!(body_text.contains("nip44-v2"));

        channel_keys::sync_keys(HashMap::new());
    }

    /// Companion to the above: an unkeyed channel's message is untouched —
    /// buzz#33 must not seal traffic that was never meant to be private.
    #[test]
    fn an_unkeyed_channel_message_reaches_the_dispatch_boundary_as_plaintext() {
        use crate::channel_keys::{self, channel_keys_test_lock};
        use nostr::JsonUtil;
        use std::collections::HashMap;

        let _guard = channel_keys_test_lock();
        channel_keys::sync_keys(HashMap::new());

        let channel = uuid::Uuid::new_v4();
        let builder = crate::events::build_message(
            channel,
            "public roadmap update",
            None,
            &[],
            &[],
            &[],
            &[],
        )
        .expect("build unkeyed channel message");
        let event = builder
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign unkeyed channel message");

        let body = event.as_json().into_bytes();
        let body_text = String::from_utf8(body).expect("event JSON is UTF-8");

        assert!(body_text.contains("public roadmap update"));
        assert!(!body_text.contains("\"encrypted\""));
    }
}
