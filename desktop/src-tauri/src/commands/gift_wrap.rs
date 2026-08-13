//! Rust seal/unseal commands for NIP-59 gift wraps (buzz#43).
//!
//! Follow-up from buzz#16/#18: the channel-key gift-wrap paths used to reach
//! into the renderer for the user's secret key (`identitySecretKey.ts`) to do
//! the two NIP-44 layers a NIP-59 wrap needs — `sign_event` only signs, it
//! does not do the ECDH a seal or an unwrap requires. These two commands do
//! that ECDH against the identity already held in `AppState`, so the secret
//! key never has to leave the Rust side for a channel-key wrap the way it
//! already doesn't for a signature.
//!
//! `seal_gift_wrap` builds the rumor from `kind`/`content`/`tags`, seals it
//! under this identity, and wraps it to `recipient` under a throwaway key —
//! `EventBuilder::gift_wrap`'s three layers, unchanged from NIP-59. Note what
//! it does NOT decide: whether `recipient` should get this rumor at all. That
//! judgment (admin lists, epochs) stays in the frontend, which is why this
//! command takes an already-built rumor shape rather than a channel ID.
//!
//! `unseal_gift_wrap` is the receiving half: open a wrap addressed to this
//! identity and return the rumor's sender (the seal's signer — the one field
//! NIP-59 makes load-bearing for authority) plus its kind/content/tags. A
//! wrap for someone else, or anything malformed, is `Ok(None)` rather than an
//! `Err` — on an open relay that is the overwhelmingly common outcome, not a
//! failure, exactly as it was in the TS-only `unwrapChannelKey` this replaces.

use nostr::nips::nip59;
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, UnsignedEvent};
use tauri::State;

use crate::app_state::AppState;

/// One opened gift wrap, ready for the frontend to validate against an admin
/// list. `sender` is the seal's signer, verified by [`nip59::extract_rumor`]
/// — never the wrap's ephemeral key, and never a value the rumor merely
/// claims for itself.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnsealedGift {
    pub sender: String,
    pub kind: u16,
    pub content: String,
    pub tags: Vec<Vec<String>>,
    pub created_at: u64,
}

async fn seal_gift_wrap_with_keys(
    keys: &Keys,
    recipient: &str,
    kind: u16,
    content: String,
    tags: Vec<Vec<String>>,
) -> Result<String, String> {
    let receiver = PublicKey::from_hex(recipient.trim())
        .map_err(|error| format!("invalid recipient pubkey: {error}"))?;

    let nostr_tags = tags
        .into_iter()
        .map(|tag| Tag::parse(tag).map_err(|error| format!("invalid tag: {error}")))
        .collect::<Result<Vec<_>, String>>()?;

    let rumor: UnsignedEvent = EventBuilder::new(Kind::Custom(kind), content)
        .tags(nostr_tags)
        .build(keys.public_key());

    let wrap: Event = EventBuilder::gift_wrap(keys, &receiver, rumor, [])
        .await
        .map_err(|error| format!("gift wrap failed: {error}"))?;

    Ok(wrap.as_json())
}

async fn unseal_gift_wrap_with_keys(
    keys: &Keys,
    wrap_json: &str,
) -> Result<Option<UnsealedGift>, String> {
    let wrap = match Event::from_json(wrap_json) {
        Ok(event) => event,
        Err(_) => return Ok(None),
    };

    match nip59::extract_rumor(keys, &wrap).await {
        Ok(unwrapped) => Ok(Some(UnsealedGift {
            sender: unwrapped.sender.to_hex(),
            kind: unwrapped.rumor.kind.as_u16(),
            content: unwrapped.rumor.content,
            tags: unwrapped
                .rumor
                .tags
                .iter()
                .map(|tag| tag.as_slice().to_vec())
                .collect(),
            created_at: unwrapped.rumor.created_at.as_secs(),
        })),
        // A wrap for another recipient fails the MAC inside `extract_rumor`,
        // exactly like the TS-only path this replaces. That is the common
        // case on an open relay, not an error condition.
        Err(_) => Ok(None),
    }
}

/// Seal `content` (of kind `kind`, tagged `tags`) as a NIP-59 gift wrap to
/// `recipient`, sealed under this identity. Returns the kind:1059 event JSON,
/// ready to publish.
#[tauri::command]
pub async fn seal_gift_wrap(
    recipient: String,
    kind: u16,
    content: String,
    tags: Vec<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let keys = state.signing_keys()?;
    seal_gift_wrap_with_keys(&keys, &recipient, kind, content, tags).await
}

/// Open a gift wrap addressed to this identity. `None` for anything that is
/// not a well-formed kind:1059 wrap this identity can open — malformed JSON,
/// a wrap for someone else, or a seal that fails to verify.
#[tauri::command]
pub async fn unseal_gift_wrap(
    wrap_json: String,
    state: State<'_, AppState>,
) -> Result<Option<UnsealedGift>, String> {
    let keys = state.signing_keys()?;
    unseal_gift_wrap_with_keys(&keys, &wrap_json).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn seals_and_unseals_a_round_trip() {
        let sender = Keys::generate();
        let receiver = Keys::generate();

        let wrap_json = seal_gift_wrap_with_keys(
            &sender,
            &receiver.public_key().to_hex(),
            44300,
            "hello".to_string(),
            vec![
                vec!["h".to_string(), "channel-id".to_string()],
                vec!["key".to_string(), "deadbeef".to_string(), "1".to_string()],
            ],
        )
        .await
        .unwrap();

        let unsealed = unseal_gift_wrap_with_keys(&receiver, &wrap_json)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(unsealed.sender, sender.public_key().to_hex());
        assert_eq!(unsealed.kind, 44300);
        assert_eq!(unsealed.content, "hello");
        assert_eq!(
            unsealed.tags,
            vec![
                vec!["h".to_string(), "channel-id".to_string()],
                vec!["key".to_string(), "deadbeef".to_string(), "1".to_string()],
            ]
        );
    }

    #[tokio::test]
    async fn a_wrap_for_someone_else_does_not_open() {
        let sender = Keys::generate();
        let receiver = Keys::generate();
        let outsider = Keys::generate();

        let wrap_json = seal_gift_wrap_with_keys(
            &sender,
            &receiver.public_key().to_hex(),
            1,
            "secret".to_string(),
            vec![],
        )
        .await
        .unwrap();

        assert_eq!(
            unseal_gift_wrap_with_keys(&outsider, &wrap_json)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn an_event_that_is_not_a_gift_wrap_does_not_open() {
        let receiver = Keys::generate();
        let note = EventBuilder::text_note("hi")
            .sign_with_keys(&Keys::generate())
            .unwrap();

        assert_eq!(
            unseal_gift_wrap_with_keys(&receiver, &note.as_json())
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn malformed_json_does_not_open() {
        let receiver = Keys::generate();

        assert_eq!(
            unseal_gift_wrap_with_keys(&receiver, "not json")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn rejects_an_invalid_recipient_pubkey() {
        let sender = Keys::generate();

        let error = seal_gift_wrap_with_keys(&sender, "not-a-pubkey", 1, "x".to_string(), vec![])
            .await
            .unwrap_err();

        assert!(error.contains("invalid recipient pubkey"), "{error}");
    }
}
