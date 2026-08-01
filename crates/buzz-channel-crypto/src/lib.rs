//! Channel-key primitives: key ids, key parsing, and NIP-44 v2 seal/open.
//!
//! ## Why this crate exists (buzz#19)
//!
//! buzz#33 put these primitives in `desktop/src-tauri/src/channel_keys.rs` so
//! Rust-built desktop writes could seal before signing. buzz#19 needs the same
//! primitives in `buzz-cli`, for an agent-member that opens channel history and
//! seals its own replies — and `desktop/src-tauri` is its own cargo workspace
//! (excluded from the root one), so the CLI cannot depend on it. Rather than
//! carry a second implementation of a wire format that three clients must agree
//! on byte-for-byte, the core moved here and both callers point at it.
//!
//! The move was deliberately mechanical: the functions, the domain constant,
//! and the cross-compat test vectors are the buzz#33 originals. What stayed in
//! `channel_keys.rs` is everything desktop-specific — the process-global synced
//! key map, `sync_channel_keys`, and `BUZZ_CHANNEL_KEYS` seeding.
//!
//! ## Byte compatibility
//!
//! [`channel_key_id`] and [`seal`]/[`open`] must agree byte-for-byte with
//! `desktop/src/shared/api/channelEncryption.ts`'s `channelKeyId` /
//! `encryptChannelContent` / `decryptChannelContent`: the marker tag they
//! produce (`["encrypted", "nip44-v2", "<keyId>"]`) is read by clients on both
//! sides of the process boundary, and by browsers with no Rust in the loop at
//! all. [`FIXED_KEY_ID_VECTOR`] pins that agreement in a test.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use nostr::nips::nip44::v2::{decrypt_to_bytes, encrypt_to_bytes, ConversationKey};
use sha2::{Digest, Sha256};

/// NIP-44 v2 conversation keys — and so channel keys — are 32 bytes.
/// Matches `channelEncryption.ts`'s `CHANNEL_KEY_BYTES`.
pub const CHANNEL_KEY_BYTES: usize = 32;

/// A channel key: 32 raw bytes.
pub type ChannelKey = [u8; CHANNEL_KEY_BYTES];

/// Domain separation for [`channel_key_id`]. Byte-identical to
/// `channelEncryption.ts`'s `KEY_ID_DOMAIN` — changing this breaks
/// cross-client key-id agreement.
const KEY_ID_DOMAIN: &[u8] = b"buzz/channel-key-id/v1";

/// Truncation length. Matches `channelEncryption.ts`'s `KEY_ID_HEX_LENGTH`.
const KEY_ID_HEX_LENGTH: usize = 16;

/// The only sealing scheme this build understands. Matches
/// `channelMessageCrypto.ts`'s `NIP44_V2_SCHEME`.
pub const NIP44_V2_SCHEME: &str = "nip44-v2";

/// Tag name declaring an event's content sealed. Matches
/// `channelMessageCrypto.ts`'s `ENCRYPTION_TAG`.
pub const ENCRYPTION_TAG: &str = "encrypted";

/// The cross-implementation test vector: the key id of a key of 32 `0xdd`
/// bytes. Computed independently in Python
/// (`sha256(b"buzz/channel-key-id/v1" + bytes([0xdd]*32))[:8]`) and asserted by
/// `channelMessageCrypto.test.mjs` on the TS side. Public so every crate that
/// re-exports these primitives can re-assert it rather than trusting a
/// transitive dependency to have done so.
pub const FIXED_KEY_ID_VECTOR: &str = "462594b863f0be53";

/// A public, non-reversible name for a key — byte-identical to
/// `channelEncryption.ts`'s `channelKeyId`. Published in the clear in every
/// sealed event's marker tag, so a reader holding several keys for one
/// channel (what rotation produces) can pick the right one without trial
/// decryption.
pub fn channel_key_id(key: &ChannelKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(KEY_ID_DOMAIN);
    hasher.update(key);
    let digest = hasher.finalize();
    hex::encode(digest)[..KEY_ID_HEX_LENGTH].to_string()
}

/// Parse a hex-encoded channel key the way `parseChannelKey` does: tolerant
/// of surrounding whitespace and an optional `0x` prefix, strict about
/// exactly 32 bytes of hex. A short or malformed value returns `None` rather
/// than silently truncating.
pub fn parse_channel_key(text: &str) -> Option<ChannelKey> {
    let trimmed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let without_prefix = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(&trimmed);
    if without_prefix.len() != CHANNEL_KEY_BYTES * 2 {
        return None;
    }
    let bytes = hex::decode(without_prefix.to_ascii_lowercase()).ok()?;
    bytes.try_into().ok()
}

/// Seal `plaintext` under `key`, returning the NIP-44 v2 base64 payload.
/// Byte-identical output shape to `encryptChannelContent` (modulo the random
/// nonce every NIP-44 encryption picks, which makes any two ciphertexts of
/// the same plaintext differ — round-trip is what's provable, not equality).
pub fn seal(plaintext: &str, key: &ChannelKey) -> String {
    let conversation_key = ConversationKey::new(*key);
    // `encrypt_to_bytes` (the `std`-gated helper) draws its nonce from the
    // OS CSPRNG, same as `nostr-tools/nip44`'s `encrypt`.
    let payload = encrypt_to_bytes(&conversation_key, plaintext.as_bytes())
        .expect("nip44 v2 encryption of a channel message cannot fail for well-formed input");
    BASE64.encode(payload)
}

/// Open a NIP-44 v2 payload sealed under `key`, or `None` when it cannot be
/// opened — a wrong key and a corrupted payload are indistinguishable by
/// design (NIP-44's MAC), and callers want the same handling for both,
/// mirroring `decryptChannelContent`'s collapse to `null`.
pub fn open(payload: &str, key: &ChannelKey) -> Option<String> {
    let conversation_key = ConversationKey::new(*key);
    let bytes = BASE64.decode(payload).ok()?;
    let plaintext = decrypt_to_bytes(&conversation_key, &bytes).ok()?;
    String::from_utf8(plaintext).ok()
}

/// The marker tag a sealed event carries: `["encrypted", "nip44-v2", keyId]`.
/// Mirrors `channelMessageCrypto.ts`'s `encryptionTag`.
pub fn encryption_tag(key: &ChannelKey) -> [String; 3] {
    [
        ENCRYPTION_TAG.to_string(),
        NIP44_V2_SCHEME.to_string(),
        channel_key_id(key),
    ]
}

/// The key id an event's marker tag names, or `None` when the event is not
/// sealed with a scheme this build understands.
///
/// A tag naming a *different* scheme is treated exactly like no tag at all
/// here; callers that must not silently render such an event as plaintext
/// check for the tag's presence separately (see `buzz-cli`'s
/// `commands::toon::read`).
pub fn key_id_from_tags<S: AsRef<str>>(tags: &[Vec<S>]) -> Option<&str> {
    tags.iter().find_map(|tag| {
        let name = tag.first()?.as_ref();
        let scheme = tag.get(1)?.as_ref();
        let key_id = tag.get(2)?.as_ref();
        (name == ENCRYPTION_TAG && scheme == NIP44_V2_SCHEME).then_some(key_id)
    })
}

/// Whether `tags` claims the content is sealed under *any* scheme — including
/// one this build cannot open. Distinguishing "plaintext" from "sealed with a
/// scheme I don't know" is what stops a future scheme from being rendered as
/// gibberish that looks like a message.
pub fn is_sealed<S: AsRef<str>>(tags: &[Vec<S>]) -> bool {
    tags.iter()
        .any(|tag| tag.first().is_some_and(|n| n.as_ref() == ENCRYPTION_TAG))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same 32-byte key `channelMessageCrypto.test.mjs` uses (`"d".repeat(64)`
    /// as hex). Its key id is the cross-compat vector: any implementation of
    /// `channel_key_id` that agrees with `channelKeyId` on this key agrees
    /// with it in general, since both derivations are pure functions of
    /// (domain, key).
    const FIXED_KEY: ChannelKey = [0xdd; CHANNEL_KEY_BYTES];

    #[test]
    fn key_id_matches_the_ts_fixture_vector() {
        assert_eq!(channel_key_id(&FIXED_KEY), FIXED_KEY_ID_VECTOR);
    }

    #[test]
    fn key_id_is_sixteen_lowercase_hex_chars() {
        let id = channel_key_id(&FIXED_KEY);
        assert_eq!(id.len(), 16);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn parses_hex_with_0x_prefix_and_whitespace() {
        let plain = parse_channel_key(&"d".repeat(64)).unwrap();
        let prefixed = parse_channel_key(&format!("0x{}", "d".repeat(64))).unwrap();
        let padded = parse_channel_key(&format!(" {}\n", "D".repeat(64))).unwrap();
        assert_eq!(plain, FIXED_KEY);
        assert_eq!(prefixed, FIXED_KEY);
        assert_eq!(padded, FIXED_KEY);
    }

    #[test]
    fn rejects_short_or_non_hex_keys() {
        assert!(parse_channel_key("abc").is_none());
        assert!(parse_channel_key(&"zz".repeat(32)).is_none());
        assert!(parse_channel_key(&"d".repeat(63)).is_none());
    }

    #[test]
    fn seal_then_open_round_trips() {
        let sealed = seal("rotate the deploy token today", &FIXED_KEY);
        assert!(!sealed.contains("deploy token"));
        assert_eq!(
            open(&sealed, &FIXED_KEY).unwrap(),
            "rotate the deploy token today"
        );
    }

    #[test]
    fn opening_with_the_wrong_key_fails_closed() {
        let sealed = seal("standup moved to 10:30", &FIXED_KEY);
        let wrong_key = [0x11; CHANNEL_KEY_BYTES];
        assert!(open(&sealed, &wrong_key).is_none());
    }

    #[test]
    fn encryption_tag_names_the_scheme_and_key_id() {
        let tag = encryption_tag(&FIXED_KEY);
        assert_eq!(tag[0], ENCRYPTION_TAG);
        assert_eq!(tag[1], NIP44_V2_SCHEME);
        assert_eq!(tag[2], FIXED_KEY_ID_VECTOR);
    }

    #[test]
    fn key_id_from_tags_finds_the_marker_and_ignores_others() {
        let tags = vec![
            vec!["h".to_string(), "engineering".to_string()],
            vec![
                ENCRYPTION_TAG.to_string(),
                NIP44_V2_SCHEME.to_string(),
                FIXED_KEY_ID_VECTOR.to_string(),
            ],
        ];
        assert_eq!(key_id_from_tags(&tags), Some(FIXED_KEY_ID_VECTOR));
        assert!(is_sealed(&tags));
    }

    #[test]
    fn an_unknown_scheme_is_sealed_but_has_no_usable_key_id() {
        let tags = vec![vec![
            ENCRYPTION_TAG.to_string(),
            "nip44-v3-from-the-future".to_string(),
            "deadbeefdeadbeef".to_string(),
        ]];
        assert_eq!(key_id_from_tags(&tags), None);
        assert!(
            is_sealed(&tags),
            "a scheme we cannot open must still read as sealed, never as plaintext"
        );
    }

    #[test]
    fn plaintext_tags_are_neither_sealed_nor_keyed() {
        let tags = vec![vec!["h".to_string(), "engineering".to_string()]];
        assert_eq!(key_id_from_tags(&tags), None);
        assert!(!is_sealed(&tags));
    }
}
