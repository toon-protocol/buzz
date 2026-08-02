//! TOON huddle audio frame events (buzz#23, ADR 0003).
//!
//! On the TOON transport there is no audio room: each ~20 ms Opus frame is
//! one ephemeral Nostr event (kind [`FRAME_KIND`]), published as a
//! dust-priced paid write over the connector's BTP session, and every
//! listener receives it through a free relay subscription. This module is
//! the codec for that event — the exact inverse pair the send and receive
//! pipelines share:
//!
//! ```text
//! build_frame_event:  header ‖ opus ─ base64 ─ seal(channel key)? ─ sign
//! parse_frame_event:  verify shape ─ open(channel key)? ─ base64 ─ header ‖ opus
//! ```
//!
//! The binary payload reuses the existing v2 wire header
//! ([`super::wire::FrameHeader`], 8 bytes: seq, 48 kHz media timestamp,
//! dBov level, flags) so the receive side feeds NetEq the same
//! sender-authored seq/timestamp it always has. What changes is the
//! envelope: `base64(header ‖ opus)` becomes the event `content`, the
//! huddle's ephemeral channel id rides in the `h` tag, and — for a keyed
//! (private) channel — the content is NIP-44-sealed with the channel key
//! *before signing*, the same seal-before-sign order every other keyed
//! write in this crate follows (buzz#33). A non-member holding the event
//! sees ciphertext only.

// Staged for buzz#23: consumed by the TOON huddle pipeline (stage 2 wires the
// send/receive loops through this codec). Remove the allow with that wiring.
#![allow(dead_code)]

use base64::Engine as _;
use nostr::JsonUtil as _;

use super::wire::{FrameHeader, V2_HEADER_LEN};
use crate::channel_keys;

/// Kind for one huddle audio frame. Mirrors
/// `buzz-core`'s `KIND_HUDDLE_AUDIO_FRAME` (ephemeral range — never stored).
pub const FRAME_KIND: u16 = buzz_core_pkg::kind::KIND_HUDDLE_AUDIO_FRAME as u16;

const _: () = assert!(
    buzz_core_pkg::kind::KIND_HUDDLE_AUDIO_FRAME >= buzz_core_pkg::kind::EPHEMERAL_KIND_MIN
        && buzz_core_pkg::kind::KIND_HUDDLE_AUDIO_FRAME <= buzz_core_pkg::kind::EPHEMERAL_KIND_MAX,
    "huddle audio frames must be ephemeral — a stored kind would persist (and bill) every syllable"
);

fn base64_engine() -> &'static base64::engine::GeneralPurpose {
    &base64::engine::general_purpose::STANDARD
}

/// Build and sign one frame event for `channel_id`.
///
/// When this process holds a channel key for `channel_id` (synced from the
/// frontend's key store, see [`crate::channel_keys`]), the content is sealed
/// under it and the event carries the `["encrypted","nip44-v2",keyId]`
/// marker tag; otherwise the base64 payload is the content as-is. Sealing
/// happens before signing, so the signature covers exactly the bytes the
/// wire carries.
pub fn build_frame_event(
    channel_id: &str,
    header: FrameHeader,
    opus_payload: &[u8],
    keys: &nostr::Keys,
) -> Result<nostr::Event, String> {
    if opus_payload.is_empty() {
        return Err("refusing to build a frame event with an empty Opus payload".to_string());
    }
    let mut binary = Vec::with_capacity(V2_HEADER_LEN + opus_payload.len());
    binary.extend_from_slice(&header.encode());
    binary.extend_from_slice(opus_payload);
    let encoded = base64_engine().encode(&binary);

    let sealed = channel_keys::seal_for_channel(channel_id, &encoded);

    let mut tags = vec![nostr::Tag::parse(["h", channel_id]).map_err(|e| format!("h tag: {e}"))?];
    if let Some(marker) = sealed.tag {
        tags.push(
            nostr::Tag::parse(marker.iter().map(String::as_str))
                .map_err(|e| format!("encrypted tag: {e}"))?,
        );
    }

    nostr::EventBuilder::new(nostr::Kind::Custom(FRAME_KIND), sealed.content)
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| format!("sign frame event: {e}"))
}

/// One decoded inbound frame, ready for the jitter buffer.
#[derive(Debug)]
pub struct ParsedFrame {
    pub header: FrameHeader,
    pub opus_payload: Vec<u8>,
}

/// Why an inbound event yielded no frame. `Undecryptable` is the one variant
/// the pipeline treats differently from plain garbage: it is the expected
/// state of a non-member (or a member whose key sync lags a rotation), not a
/// malformed event.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameParseError {
    /// Not a frame event for this channel (wrong kind or wrong/missing `h`).
    NotAFrame,
    /// Sealed content this process holds no opening key for.
    Undecryptable,
    /// Frame-shaped but with an invalid payload (bad base64, short header,
    /// empty Opus payload).
    Malformed,
}

/// Decode one relay event back into a frame.
///
/// Checks the kind and the `h` tag against `channel_id`, opens sealed
/// content with the synced channel key when the event carries the
/// `encrypted` marker, then splits `base64(header ‖ opus)`. Signature
/// verification is the caller's job — the receive pipeline verifies before
/// attributing the frame to a speaker.
pub fn parse_frame_event(
    event: &nostr::Event,
    channel_id: &str,
) -> Result<ParsedFrame, FrameParseError> {
    if event.kind != nostr::Kind::Custom(FRAME_KIND) {
        return Err(FrameParseError::NotAFrame);
    }

    let mut h_matches = false;
    let mut sealed_scheme: Option<&str> = None;
    for tag in event.tags.iter() {
        let slice = tag.as_slice();
        match slice.first().map(String::as_str) {
            Some("h") => {
                if slice.get(1).map(String::as_str) == Some(channel_id) {
                    h_matches = true;
                }
            }
            Some(channel_keys::ENCRYPTION_TAG) => {
                sealed_scheme = slice.get(1).map(String::as_str);
            }
            _ => {}
        }
    }
    if !h_matches {
        return Err(FrameParseError::NotAFrame);
    }

    let encoded = match sealed_scheme {
        None => event.content.clone(),
        Some(channel_keys::NIP44_V2_SCHEME) => {
            let Some(key) = channel_keys::get_channel_key(channel_id) else {
                return Err(FrameParseError::Undecryptable);
            };
            match channel_keys::open(&event.content, &key) {
                Some(plain) => plain,
                // Wrong epoch (rotation raced the frame) reads the same as
                // no key: this process cannot open it.
                None => return Err(FrameParseError::Undecryptable),
            }
        }
        Some(_) => return Err(FrameParseError::Undecryptable),
    };

    let binary = base64_engine()
        .decode(encoded.as_bytes())
        .map_err(|_| FrameParseError::Malformed)?;
    let Some((header, opus_payload)) = FrameHeader::parse(&binary) else {
        return Err(FrameParseError::Malformed);
    };
    if opus_payload.is_empty() {
        return Err(FrameParseError::Malformed);
    }
    Ok(ParsedFrame {
        header,
        opus_payload: opus_payload.to_vec(),
    })
}

/// Parse raw relay JSON into a verified event. Split from
/// [`parse_frame_event`] so the pipeline can drop events whose signature
/// doesn't check out before any decryption work happens.
pub fn verified_event_from_json(json: &str) -> Option<nostr::Event> {
    let event = nostr::Event::from_json(json).ok()?;
    event.verify().ok()?;
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_keys::{channel_keys_test_lock, ChannelKey, CHANNEL_KEY_BYTES};
    use std::collections::HashMap;

    const CHANNEL: &str = "7f0a3c1e-huddle-channel";

    fn sample_header() -> FrameHeader {
        FrameHeader {
            seq: 421,
            ts_48k: 421 * 960,
            level_dbov: -23,
            flags: 0,
        }
    }

    fn sample_opus() -> Vec<u8> {
        (0u8..160).collect()
    }

    #[test]
    fn plaintext_round_trip_preserves_header_and_payload() {
        let _guard = channel_keys_test_lock();
        crate::channel_keys::sync_keys(HashMap::new());

        let keys = nostr::Keys::generate();
        let event =
            build_frame_event(CHANNEL, sample_header(), &sample_opus(), &keys).expect("build");
        assert_eq!(event.kind, nostr::Kind::Custom(FRAME_KIND));

        let parsed = parse_frame_event(&event, CHANNEL).expect("parse");
        assert_eq!(parsed.header, sample_header());
        assert_eq!(parsed.opus_payload, sample_opus());
    }

    #[test]
    fn events_scope_to_their_channel_via_the_h_tag() {
        let _guard = channel_keys_test_lock();
        crate::channel_keys::sync_keys(HashMap::new());

        let keys = nostr::Keys::generate();
        let event =
            build_frame_event(CHANNEL, sample_header(), &sample_opus(), &keys).expect("build");
        assert_eq!(
            parse_frame_event(&event, "some-other-channel").unwrap_err(),
            FrameParseError::NotAFrame,
        );
    }

    #[test]
    fn keyed_channel_frames_are_ciphertext_to_non_members() {
        let _guard = channel_keys_test_lock();
        let key: ChannelKey = [0x5b; CHANNEL_KEY_BYTES];
        let mut entries = HashMap::new();
        entries.insert(CHANNEL.to_string(), hex::encode(key));
        crate::channel_keys::sync_keys(entries);

        let keys = nostr::Keys::generate();
        let opus = sample_opus();
        let event = build_frame_event(CHANNEL, sample_header(), &opus, &keys).expect("build");

        // The event carries the seal marker and its content is not the
        // plaintext base64 payload.
        let mut plain = Vec::new();
        plain.extend_from_slice(&sample_header().encode());
        plain.extend_from_slice(&opus);
        let plain_b64 = base64_engine().encode(&plain);
        assert_ne!(event.content, plain_b64);
        assert!(event
            .tags
            .iter()
            .any(|t| t.as_slice().first().map(String::as_str) == Some("encrypted")));

        // A member (key synced) opens it.
        let parsed = parse_frame_event(&event, CHANNEL).expect("member parse");
        assert_eq!(parsed.opus_payload, opus);

        // A non-member (no key synced) gets Undecryptable — never audio.
        crate::channel_keys::sync_keys(HashMap::new());
        assert_eq!(
            parse_frame_event(&event, CHANNEL).unwrap_err(),
            FrameParseError::Undecryptable,
        );
    }

    #[test]
    fn a_stale_epoch_key_cannot_open_a_rotated_frame() {
        let _guard = channel_keys_test_lock();
        let current: ChannelKey = [0x11; CHANNEL_KEY_BYTES];
        let mut entries = HashMap::new();
        entries.insert(CHANNEL.to_string(), hex::encode(current));
        crate::channel_keys::sync_keys(entries);

        let keys = nostr::Keys::generate();
        let event =
            build_frame_event(CHANNEL, sample_header(), &sample_opus(), &keys).expect("build");

        // The removed member still holds the previous epoch's key.
        let stale: ChannelKey = [0x22; CHANNEL_KEY_BYTES];
        let mut removed = HashMap::new();
        removed.insert(CHANNEL.to_string(), hex::encode(stale));
        crate::channel_keys::sync_keys(removed);

        assert_eq!(
            parse_frame_event(&event, CHANNEL).unwrap_err(),
            FrameParseError::Undecryptable,
        );
        crate::channel_keys::sync_keys(HashMap::new());
    }

    #[test]
    fn malformed_content_is_rejected_not_panicked_on() {
        let _guard = channel_keys_test_lock();
        crate::channel_keys::sync_keys(HashMap::new());

        let keys = nostr::Keys::generate();
        let good =
            build_frame_event(CHANNEL, sample_header(), &sample_opus(), &keys).expect("build");

        for bad_content in ["not base64 !!!", "", "AAAA"] {
            let mut event_json: serde_json::Value =
                serde_json::from_str(&good.as_json()).expect("event json");
            event_json["content"] = serde_json::Value::String(bad_content.to_string());
            // Re-parse without signature concerns — parse_frame_event doesn't
            // verify (the pipeline does, before this codec ever runs).
            let event = nostr::Event::from_json(event_json.to_string()).expect("from_json");
            assert_eq!(
                parse_frame_event(&event, CHANNEL).unwrap_err(),
                FrameParseError::Malformed,
                "content {bad_content:?} must be Malformed",
            );
        }
    }

    #[test]
    fn empty_opus_payload_is_refused_at_build_time() {
        let _guard = channel_keys_test_lock();
        crate::channel_keys::sync_keys(HashMap::new());
        let keys = nostr::Keys::generate();
        assert!(build_frame_event(CHANNEL, sample_header(), &[], &keys).is_err());
    }

    #[test]
    fn verified_event_from_json_rejects_a_tampered_event() {
        let _guard = channel_keys_test_lock();
        crate::channel_keys::sync_keys(HashMap::new());

        let keys = nostr::Keys::generate();
        let event =
            build_frame_event(CHANNEL, sample_header(), &sample_opus(), &keys).expect("build");
        let json = event.as_json();
        assert!(verified_event_from_json(&json).is_some());

        // Tamper with the content: id/sig no longer match.
        let mut tampered: serde_json::Value = serde_json::from_str(&json).expect("json");
        tampered["content"] = serde_json::Value::String("QUJDRA==".to_string());
        assert!(verified_event_from_json(&tampered.to_string()).is_none());
    }
}
