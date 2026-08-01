//! Unit tests for `events.rs`, split out to keep the production file under
//! the desktop file-size ratchet (`scripts/check-file-sizes.mjs`). Same
//! pattern as `commands/channels_tests.rs` / `commands/messages_tests.rs`.
use super::*;
use nostr::Keys;

#[test]
fn channel_builders_reject_hash_only_names() {
    let channel_id = Uuid::new_v4();
    assert!(build_create_channel(channel_id, "###", "open", "stream", None, None).is_err());
    assert!(build_update_channel(channel_id, Some("###"), None, None, None).is_err());
}
/// Builder layout regression for the NIP-IA owner-of-agent archive flow.
/// Compares against `docs/nips/NIP-IA.md` §Vector 1.
#[test]
fn archive_identity_request_matches_spec_vector_1_layout() {
    const OWNER_HEX: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const TARGET_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const CONDITIONS: &str = "kind=1&created_at<1713957000";
    const SIG: &str = "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";

    let auth: [String; 4] = [
        "auth".into(),
        OWNER_HEX.into(),
        CONDITIONS.into(),
        SIG.into(),
    ];
    let builder = build_archive_identity_request(
        TARGET_HEX,
        "Archiving zombie agent after rebuild.",
        Some("bot-rebuilt"),
        None,
        Some(&auth),
    )
    .expect("build_archive_identity_request");

    let owner_secret = nostr::SecretKey::from_hex(
        "0000000000000000000000000000000000000000000000000000000000000001",
    )
    .unwrap();
    let owner_keys = Keys::new(owner_secret);
    let event = builder.sign_with_keys(&owner_keys).unwrap();

    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();

    assert_eq!(event.kind, Kind::Custom(KIND_IA_ARCHIVE_REQUEST as u16));
    // Spec layout: ["-"], ["p", target], ["reason", code], ["auth", ...]
    assert_eq!(tags[0], vec!["-"]);
    assert_eq!(tags[1], vec!["p", TARGET_HEX]);
    assert_eq!(tags[2], vec!["reason", "bot-rebuilt"]);
    assert_eq!(tags[3], vec!["auth", OWNER_HEX, CONDITIONS, SIG]);
}

#[test]
fn archive_request_rejects_replaced_by_equal_target() {
    const TARGET_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    let err =
        build_archive_identity_request(TARGET_HEX, "", None, Some(TARGET_HEX), None).unwrap_err();
    assert!(err.contains("replaced-by"));
}

#[test]
fn unarchive_request_layout_self_path() {
    const TARGET_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    let builder =
        build_unarchive_identity_request(TARGET_HEX, "I am active again.", Some("returned"), None)
            .unwrap();
    let target_secret = nostr::SecretKey::from_hex(
        "0000000000000000000000000000000000000000000000000000000000000002",
    )
    .unwrap();
    let event = builder.sign_with_keys(&Keys::new(target_secret)).unwrap();
    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
    assert_eq!(event.kind, Kind::Custom(KIND_IA_UNARCHIVE_REQUEST as u16));
    // Self-unarchive: the `p` tag MUST point at the signer. Verifies our
    // `.allow_self_tagging()` call survives nostr 0.44's default scrub.
    assert_eq!(tags[0], vec!["-"]);
    assert_eq!(tags[1], vec!["p", TARGET_HEX]);
    assert_eq!(tags[2], vec!["reason", "returned"]);
    assert_eq!(tags.len(), 3, "self unarchive must not carry auth tag");
    assert_eq!(event.pubkey.to_hex(), TARGET_HEX);
}

// ── build_message_edit `p`-tag emission (lane 8ace8eed) ──────────────
//
// The composer diffs the edited body's mentions against the original and
// hands `build_message_edit` only the *newly added* pubkeys. These tests
// pin the builder's contract given that contract: emit a `p` per added
// mention (deduped, lowercased), and none when the added set is empty
// (typo-fix edit) — so an unchanged mention set re-wakes nobody.

const CH_ID: &str = "11111111-1111-4111-8111-111111111111";
const ALICE_HEX: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const BOB_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

fn edit_tags(mentions: &[&str]) -> Vec<Vec<String>> {
    let channel = Uuid::parse_str(CH_ID).unwrap();
    let target =
        EventId::from_hex("d24da132115ca0a46233cf4c2ad8338fbf914250cbcaa9181a6dd59533cb5ac1")
            .unwrap();
    let builder = build_message_edit(channel, target, "hi @alice", &[], &[], mentions).unwrap();
    let secret = nostr::SecretKey::from_hex(
        "0000000000000000000000000000000000000000000000000000000000000003",
    )
    .unwrap();
    let event = builder.sign_with_keys(&Keys::new(secret)).unwrap();
    event.tags.iter().map(|t| t.as_slice().to_vec()).collect()
}

#[test]
fn edit_with_added_mention_emits_p_tag() {
    let tags = edit_tags(&[ALICE_HEX]);
    assert_eq!(tags[0][0], "h");
    assert_eq!(tags[1][0], "e");
    // The `p` tag rides right after the `e` tag (insertion order).
    assert_eq!(tags[2], vec!["p".to_string(), ALICE_HEX.to_string()]);
}

#[test]
fn edit_with_no_added_mentions_emits_no_p_tag() {
    // Typo-fix edit: mention set unchanged, so the composer passes `&[]`.
    // The edit event must carry no `p` tag and re-wake nobody.
    let tags = edit_tags(&[]);
    assert!(
        !tags
            .iter()
            .any(|t| t.first().map(String::as_str) == Some("p")),
        "unchanged-mention edit must not emit any `p` tag, got {tags:?}"
    );
}

#[test]
fn edit_mentions_are_deduped_and_lowercased() {
    let alice_upper = ALICE_HEX.to_ascii_uppercase();
    let tags = edit_tags(&[ALICE_HEX, &alice_upper, BOB_HEX]);
    let p_tags: Vec<&Vec<String>> = tags
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("p"))
        .collect();
    // ALICE appears twice (mixed case) but collapses to one lowercase tag.
    assert_eq!(
        p_tags.len(),
        2,
        "duplicate mention must collapse, got {p_tags:?}"
    );
    assert_eq!(p_tags[0], &vec!["p".to_string(), ALICE_HEX.to_string()]);
    assert_eq!(p_tags[1], &vec!["p".to_string(), BOB_HEX.to_string()]);
}

// ── Channel-key sealing (buzz#33) ────────────────────────────────────
//
// These builders are the Rust-side write path buzz#12 never covered:
// Rust builds and signs its own events for threaded replies, media
// messages, custom emoji, and the huddle STT pipeline, all of which
// funnel through `build_message`/`build_message_with_client_tags`. A
// keyed channel must come out sealed here, before `submit_event` ever
// signs it — exactly like `sendStreamMessage` seals before
// `signRelayEvent` on the TS side.

use crate::channel_keys::{self, channel_keys_test_lock, ChannelKey, CHANNEL_KEY_BYTES};
use std::collections::HashMap;

const CHANNEL_FIXED_KEY: ChannelKey = [0xdd; CHANNEL_KEY_BYTES];
const CHANNEL_FIXED_KEY_ID: &str = "462594b863f0be53";

#[test]
fn build_message_for_unkeyed_channel_posts_in_the_clear() {
    let _guard = channel_keys_test_lock();
    channel_keys::sync_keys(HashMap::new());

    let channel = Uuid::new_v4();
    let builder =
        build_message(channel, "public roadmap update", None, &[], &[], &[], &[]).unwrap();
    let event = builder
        .sign_with_keys(&Keys::generate())
        .expect("sign unkeyed message");

    assert_eq!(event.content, "public roadmap update");
    assert!(
        !event
            .tags
            .iter()
            .any(|t| t.as_slice().first().map(String::as_str) == Some("encrypted")),
        "unkeyed channel must carry no encrypted marker tag"
    );
}

#[test]
fn build_message_for_keyed_channel_seals_content_and_tags_it() {
    let _guard = channel_keys_test_lock();
    let channel = Uuid::new_v4();
    let mut entries = HashMap::new();
    entries.insert(channel.to_string(), hex::encode(CHANNEL_FIXED_KEY));
    channel_keys::sync_keys(entries);

    let builder = build_message(
        channel,
        "rotate the deploy token today",
        None,
        &[],
        &[],
        &[],
        &[],
    )
    .unwrap();
    let event = builder
        .sign_with_keys(&Keys::generate())
        .expect("sign keyed message");

    assert!(!event.content.contains("deploy token"));
    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
    assert_eq!(tags[0], vec!["h".to_string(), channel.to_string()]);
    assert_eq!(
        tags[1],
        vec![
            "encrypted".to_string(),
            "nip44-v2".to_string(),
            CHANNEL_FIXED_KEY_ID.to_string(),
        ]
    );
    assert_eq!(
        channel_keys::open(&event.content, &CHANNEL_FIXED_KEY).unwrap(),
        "rotate the deploy token today"
    );

    channel_keys::sync_keys(HashMap::new());
}

#[test]
fn build_message_seals_thread_replies_media_and_emoji_alike() {
    // Threaded replies, media messages, and custom emoji all go through
    // the same builder as a plain message — this test's point is that
    // adding thread/media/emoji tags does not bypass or duplicate the
    // seal, and the caller-supplied tags still land intact alongside it.
    let _guard = channel_keys_test_lock();
    let channel = Uuid::new_v4();
    let mut entries = HashMap::new();
    entries.insert(channel.to_string(), hex::encode(CHANNEL_FIXED_KEY));
    channel_keys::sync_keys(entries);

    let root =
        EventId::from_hex("d24da132115ca0a46233cf4c2ad8338fbf914250cbcaa9181a6dd59533cb5ac1")
            .unwrap();
    let thread_ref = ThreadRef {
        root_event_id: root,
        parent_event_id: root,
    };
    let media = vec![vec![
        "imeta".to_string(),
        "url https://example.test/pic.png".to_string(),
    ]];
    let emoji = vec![vec![
        "emoji".to_string(),
        "party".to_string(),
        "https://example.test/party.png".to_string(),
    ]];

    let builder = build_message(
        channel,
        "reply with an image :party:",
        Some(&thread_ref),
        &[],
        &media,
        &emoji,
        &[],
    )
    .unwrap();
    let event = builder
        .sign_with_keys(&Keys::generate())
        .expect("sign keyed reply");

    assert!(!event.content.contains("reply with an image"));
    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
    let encrypted_count = tags
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("encrypted"))
        .count();
    assert_eq!(encrypted_count, 1, "exactly one marker tag, got {tags:?}");
    assert!(tags.iter().any(|t| t[0] == "imeta"));
    assert!(tags.iter().any(|t| t[0] == "emoji"));
    assert!(tags.iter().any(|t| t[0] == "e"));

    channel_keys::sync_keys(HashMap::new());
}
