//! Free reads from a TOON relay (buzz#19).
//!
//! TOON charges for writes and nothing for reads, so this side needs none of
//! the machinery the write path does: no sidecar, no channel, no claim. It is
//! a plain NIP-01 `REQ` over a WebSocket, run to EOSE and closed — the Rust
//! counterpart of `desktop/src/shared/api/toonRelayReader.ts`, minus the
//! live-subscription/reconnect half the CLI has no use for.
//!
//! ## The double-encoding tolerance is the point
//!
//! The devnet relay does not always speak plain NIP-01: an `EVENT` payload can
//! arrive as a JSON *string* containing the event JSON rather than as an
//! inline object, and the whole frame is sometimes double-encoded the same
//! way. A reader that assumes one encoding does not error on the other — it
//! silently sees no events, and presents as an empty channel with nothing in
//! the log. Both encodings are decoded in [`decode_frame`], a pure function,
//! so the tolerance is unit-tested rather than rediscovered on devnet. This
//! mirrors `toonRelayFrames.ts` deliberately; it is also why this module does
//! not reuse `buzz-ws-client`'s `parse_relay_message`, which is strict.

use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use nostr::Event;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_key_grant::GIFT_WRAP_KIND;
use crate::error::CliError;

/// The shared devnet relay. Matches `TOON_DEVNET_DEFAULTS.relayUrl` in
/// `desktop/src/shared/api/toonTransportConfig.ts` — note `relay-ws`, not
/// `relay`: the latter resolves to parked DNS and fails the TLS handshake.
pub const DEFAULT_TOON_RELAY_URL: &str = "wss://relay-ws.devnet.toonprotocol.dev";

/// How long a read waits for EOSE before returning what it has. A read that
/// hangs is worse than a short one: the caller can always ask again.
const READ_TIMEOUT_SECS: u64 = 20;

/// A decoded relay frame, or `None` for bytes this reader does not act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToonFrame {
    Event {
        subscription_id: String,
        event: Box<Event>,
    },
    Eose {
        subscription_id: String,
    },
    Closed {
        subscription_id: String,
        message: String,
    },
    Notice {
        message: String,
    },
}

/// `serde_json::from_str` that also unwraps a value which is itself a JSON
/// string. One level only: a legitimately string-valued payload (a NOTICE's
/// message) must survive, so this stops as soon as the result is not
/// parseable as JSON. Mirrors `parseMaybeDoubleEncoded`.
fn parse_maybe_double_encoded(raw: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let Value::String(inner) = &parsed else {
        return Some(parsed);
    };
    Some(serde_json::from_str(inner).unwrap_or(parsed))
}

/// Shape-check and deserialize an inbound payload as a Nostr event, tolerating
/// the same string-wrapping the frame itself might have. Mirrors
/// `asRelayEvent`.
fn as_event(payload: &Value) -> Option<Event> {
    let candidate = match payload {
        Value::String(raw) => parse_maybe_double_encoded(raw)?,
        other => other.clone(),
    };
    serde_json::from_value::<Event>(candidate).ok()
}

/// Decode one inbound relay message. Unrecognised frames return `None` — a
/// malformed frame is not something the caller can act on, and the relay is
/// entitled to send frames this reader does not implement.
pub fn decode_frame(raw: &str) -> Option<ToonFrame> {
    let frame = parse_maybe_double_encoded(raw)?;
    let items = frame.as_array()?;
    let kind = items.first()?.as_str()?;
    let subscription_id = || items.get(1).and_then(Value::as_str).map(str::to_string);
    let text_at = |index: usize| {
        items
            .get(index)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };

    match kind {
        "EVENT" => Some(ToonFrame::Event {
            subscription_id: subscription_id()?,
            event: Box::new(as_event(items.get(2)?)?),
        }),
        "EOSE" => Some(ToonFrame::Eose {
            subscription_id: subscription_id()?,
        }),
        "CLOSED" => Some(ToonFrame::Closed {
            subscription_id: subscription_id()?,
            message: text_at(2),
        }),
        "NOTICE" => Some(ToonFrame::Notice {
            message: text_at(1),
        }),
        _ => None,
    }
}

/// A NIP-01 filter for a channel's messages: `kind:9` tagged `["h", id]`.
///
/// `since` is honoured when given, so a polling agent can ask only for what it
/// has not seen. Encrypted and plaintext channel messages are the same kind
/// (buzz#12 encrypts the content, not the envelope), so there is nothing
/// extra to ask for here.
pub fn channel_message_filter(channel_id: &str, limit: u32, since: Option<u64>) -> Value {
    let mut filter = serde_json::json!({
        "kinds": [9],
        "#h": [channel_id],
        "limit": limit,
    });
    if let Some(since) = since {
        filter["since"] = serde_json::json!(since);
    }
    filter
}

/// A NIP-01 filter for the gift wraps addressed to `pubkey`. Mirrors
/// `channelKeyWrapFilter`; the wrap's outer pubkey is ephemeral, so the `#p`
/// tag is the only thing that routes one to its recipient.
pub fn gift_wrap_filter(pubkey: &str, limit: u32) -> Value {
    serde_json::json!({ "kinds": [GIFT_WRAP_KIND], "#p": [pubkey], "limit": limit })
}

/// Run one `REQ` to EOSE and return the events, newest first.
///
/// Free: no payment, no auth, no sidecar. Errors are transport-level only —
/// a relay that returns nothing for a filter is an empty result, not a
/// failure, because "no messages yet" and "not a member" must be told apart
/// by the caller, not guessed at here.
pub async fn fetch(url: &str, filter: Value) -> Result<Vec<Event>, CliError> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| CliError::Other(format!("could not connect to the TOON relay {url}: {e}")))?;

    let subscription_id = "buzz-cli";
    let req = serde_json::json!(["REQ", subscription_id, filter]).to_string();
    socket
        .send(Message::Text(req.into()))
        .await
        .map_err(|e| CliError::Other(format!("failed to send REQ to {url}: {e}")))?;

    let mut events: Vec<Event> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(READ_TIMEOUT_SECS);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Ok(next) = tokio::time::timeout(remaining, socket.next()).await else {
            break; // EOSE never came; return what arrived.
        };
        let Some(message) = next else { break };
        let message =
            message.map_err(|e| CliError::Other(format!("TOON relay read failed: {e}")))?;

        match message {
            Message::Text(text) => match decode_frame(&text) {
                Some(ToonFrame::Event { event, .. }) => events.push(*event),
                Some(ToonFrame::Eose { .. }) => break,
                Some(ToonFrame::Closed { message, .. }) => {
                    return Err(CliError::Other(format!(
                        "the TOON relay closed the subscription: {message}"
                    )));
                }
                // A NOTICE or an unknown frame is not fatal; keep reading.
                _ => {}
            },
            Message::Ping(payload) => {
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let close = serde_json::json!(["CLOSE", subscription_id]).to_string();
    let _ = socket.send(Message::Text(close.into())).await;
    let _ = socket.close(None).await;

    // Newest first, matching what a relay is expected (but not required) to
    // return for a `limit`ed filter — never assume the relay sorted for us.
    events.sort_by_key(|event| std::cmp::Reverse(event.created_at));
    Ok(events)
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind};

    use super::*;

    fn sample_event() -> Event {
        EventBuilder::new(Kind::Custom(9), "hello")
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn decodes_a_plain_nip01_event_frame() {
        let event = sample_event();
        let raw = serde_json::json!(["EVENT", "sub", event]).to_string();
        match decode_frame(&raw).unwrap() {
            ToonFrame::Event {
                subscription_id,
                event: decoded,
            } => {
                assert_eq!(subscription_id, "sub");
                assert_eq!(decoded.id, event.id);
            }
            other => panic!("expected EVENT, got {other:?}"),
        }
    }

    /// The devnet shape that silently breaks naive readers: the event payload
    /// is a JSON *string*.
    #[test]
    fn decodes_an_event_whose_payload_is_a_json_string() {
        let event = sample_event();
        let payload = serde_json::to_string(&event).unwrap();
        let raw = serde_json::json!(["EVENT", "sub", payload]).to_string();
        match decode_frame(&raw).unwrap() {
            ToonFrame::Event { event: decoded, .. } => assert_eq!(decoded.id, event.id),
            other => panic!("expected EVENT, got {other:?}"),
        }
    }

    /// And the whole frame double-encoded.
    #[test]
    fn decodes_a_doubly_encoded_frame() {
        let event = sample_event();
        let inner = serde_json::json!(["EVENT", "sub", event]).to_string();
        let raw = serde_json::to_string(&inner).unwrap();
        match decode_frame(&raw).unwrap() {
            ToonFrame::Event { event: decoded, .. } => assert_eq!(decoded.id, event.id),
            other => panic!("expected EVENT, got {other:?}"),
        }
    }

    #[test]
    fn decodes_eose_closed_and_notice() {
        assert_eq!(
            decode_frame(r#"["EOSE","sub"]"#).unwrap(),
            ToonFrame::Eose {
                subscription_id: "sub".to_string()
            }
        );
        assert_eq!(
            decode_frame(r#"["CLOSED","sub","rate-limited"]"#).unwrap(),
            ToonFrame::Closed {
                subscription_id: "sub".to_string(),
                message: "rate-limited".to_string()
            }
        );
        assert_eq!(
            decode_frame(r#"["NOTICE","hello"]"#).unwrap(),
            ToonFrame::Notice {
                message: "hello".to_string()
            }
        );
    }

    #[test]
    fn a_notices_string_payload_survives_the_unwrap() {
        // `"hello"` is a valid JSON string but not valid JSON on its own, so
        // the one-level unwrap must stop rather than mangling it.
        match decode_frame(r#"["NOTICE","{not json"]"#).unwrap() {
            ToonFrame::Notice { message } => assert_eq!(message, "{not json"),
            other => panic!("expected NOTICE, got {other:?}"),
        }
    }

    #[test]
    fn junk_and_unknown_frames_decode_to_none() {
        assert!(decode_frame("not json at all").is_none());
        assert!(decode_frame("[]").is_none());
        assert!(decode_frame(r#"["OK","id",true,""]"#).is_none());
        assert!(decode_frame(r#"["EVENT","sub",{"nope":1}]"#).is_none());
        assert!(decode_frame(r#"["EVENT"]"#).is_none());
    }

    #[test]
    fn filters_carry_the_shapes_the_relay_expects() {
        let messages = channel_message_filter("engineering", 50, Some(1_700_000_000));
        assert_eq!(messages["kinds"], serde_json::json!([9]));
        assert_eq!(messages["#h"], serde_json::json!(["engineering"]));
        assert_eq!(messages["limit"], 50);
        assert_eq!(messages["since"], 1_700_000_000u64);

        let no_since = channel_message_filter("engineering", 50, None);
        assert!(no_since.get("since").is_none());

        let wraps = gift_wrap_filter("ab", 200);
        assert_eq!(wraps["kinds"], serde_json::json!([1059]));
        assert_eq!(wraps["#p"], serde_json::json!(["ab"]));
    }
}
