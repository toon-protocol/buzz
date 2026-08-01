//! Rust-side channel-key store and sealing, byte-compatible with the
//! frontend's `channelEncryption.ts` + `channelKeyStore.ts` (buzz#12).
//!
//! ## Why this exists (buzz#33)
//!
//! buzz#12 seals a channel message's `content` in TS, before `signRelayEvent`
//! ever sees it — sealing has to happen before signing, or the signature
//! covers plaintext the wire never carries. buzz#27's `event_transport` seam
//! made Rust-built writes (threaded replies, media messages, custom emoji,
//! the huddle STT pipeline) reach the network on both transports, but it
//! only ever forwards *already-signed* bytes: an event `events.rs` builds
//! and `relay::submit_event` signs for a keyed channel never passed through
//! the TS seal at all, because Rust never asked TS to build it. This module
//! is the missing seal for that path.
//!
//! ## Key access: sync from the frontend, env as a fallback layer
//!
//! Rust has no UI of its own for pasting a channel key, and the source of
//! truth — `buzz-channel-keys.v2` — lives in the webview's `localStorage`.
//! The frontend's `channelKeySync.ts` pushes the full map through the
//! `sync_channel_keys` Tauri command once at startup and again on every
//! `subscribeToChannelKeys` notification, mirroring how
//! `installRustWriteBridge` mirrors the transport seam (`event_transport`)
//! and `channelKeyBootstrap.ts` mirrors `BUZZ_CHANNEL_KEYS`. [`seed_from_env`]
//! reads that same env var directly, as a fallback layer only: it fills gaps
//! for a Rust write attempted before the webview has synced anything (or a
//! context — `buzz-cli`, a headless test harness — that never renders a
//! frontend at all), but a synced key always wins once one exists for that
//! channel — see [`sync_keys`].
//!
//! ## Byte compatibility
//!
//! [`channel_key_id`] and [`seal`]/[`open`] must agree byte-for-byte with
//! `channelEncryption.ts`'s `channelKeyId`/`encryptChannelContent`/
//! `decryptChannelContent`: the marker tag they produce
//! (`["encrypted", "nip44-v2", "<keyId>"]`) is read by clients on both sides
//! of the process boundary, and by browsers with no Rust in the loop at all.
//! Sealing uses `nostr`'s NIP-44 v2 implementation
//! (`nostr::nips::nip44::v2`) — no hand-rolled crypto — with the channel key
//! handed in directly as the conversation key, exactly as
//! `nostr-tools/nip44`'s `encrypt(plaintext, conversationKey)` does on the TS
//! side. See the module tests for the shared fixture.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

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

/// Channel keys synced from the frontend's `buzz-channel-keys.v2` store,
/// keyed by channel id. Process-global rather than an `AppState` field:
/// nothing outside this module needs to reach it, the same reasoning
/// `event_transport::bridge`'s `PENDING` map documents for its own
/// process-wide state.
///
/// One key per channel, not the frontend's ring (buzz#18). This side only
/// ever *seals*, and sealing has exactly one right answer: the epoch the
/// channel currently sends under. The older keys a rotation leaves behind
/// matter only for opening history, which stays the frontend's job — so
/// `channelKeyRecord()` pushes the sending key and a rotation arrives here as
/// an ordinary re-sync of a changed value.
static CHANNEL_KEYS: LazyLock<Mutex<HashMap<String, ChannelKey>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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

/// Replace the entire synced key map. Called by the `sync_channel_keys`
/// Tauri command every time the frontend's store changes. A full replace,
/// not a merge — a key the user deleted from channel settings must be
/// forgotten here too, or a channel Rust thinks is still keyed would keep
/// sealing into a group the user believed they'd left.
///
/// Returns human-readable warnings for entries that were not 32 bytes of
/// hex, mirroring `parseChannelKeyEnv`'s complaint style; callers log these,
/// they never block the sync.
pub fn sync_keys(entries: HashMap<String, String>) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut parsed = HashMap::with_capacity(entries.len());
    for (channel_id, hex_key) in entries {
        match parse_channel_key(&hex_key) {
            Some(key) => {
                parsed.insert(channel_id, key);
            }
            None => warnings.push(format!(
                "ignoring the synced key for channel \"{channel_id}\" — not 32 bytes of hex"
            )),
        }
    }
    if let Ok(mut keys) = CHANNEL_KEYS.lock() {
        *keys = parsed;
    }
    warnings
}

/// Seed from `BUZZ_CHANNEL_KEYS`, same `channelId=hexkey` shape (comma- or
/// newline-separated) as the TS side's `parseChannelKeyEnv`. A fallback
/// layer only: never overwrites a channel the frontend has already synced a
/// key for, so this only ever fills gaps for a write attempted before that
/// sync has happened (or a headless context that never syncs at all).
pub fn seed_from_env() -> Vec<String> {
    let mut warnings = Vec::new();
    let Some(value) = crate::relay::configured_env_var("BUZZ_CHANNEL_KEYS") else {
        return warnings;
    };
    let Ok(mut keys) = CHANNEL_KEYS.lock() else {
        return warnings;
    };
    for raw_pair in value.split(['\n', ',']) {
        let pair = raw_pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((channel_id, hex_key)) = pair.split_once('=') else {
            warnings.push(format!("ignoring \"{pair}\" — expected channelId=hexkey"));
            continue;
        };
        let channel_id = channel_id.trim();
        if channel_id.is_empty() {
            warnings.push(format!("ignoring \"{pair}\" — the channel id is empty"));
            continue;
        }
        match parse_channel_key(hex_key) {
            Some(key) => {
                keys.entry(channel_id.to_string()).or_insert(key);
            }
            None => warnings.push(format!(
                "ignoring the key for channel \"{channel_id}\" — not 32 bytes of hex"
            )),
        }
    }
    warnings
}

/// The key for `channel_id`, or `None` when this process holds no key for it
/// — the ordinary case, since most channels are public.
pub fn get_channel_key(channel_id: &str) -> Option<ChannelKey> {
    CHANNEL_KEYS.lock().ok()?.get(channel_id).copied()
}

/// What a channel write contributes before an event is built: the content to
/// use, and the marker tag (if any) to add. Mirrors
/// `channelMessageCrypto.ts`'s `SealedChannelContent`.
pub struct SealedContent {
    pub content: String,
    /// `Some(["encrypted", "nip44-v2", keyId])` for a keyed channel, `None`
    /// for an unkeyed one — encryption is switched on by the presence of a
    /// key and nothing else.
    pub tag: Option<[String; 3]>,
}

/// Seal `content` for `channel_id` if this process holds that channel's key.
///
/// An unkeyed channel is not an error — it is the common case — and the
/// caller gets its plaintext back untouched with no marker tag, exactly like
/// `sealChannelContent` on the TS side.
pub fn seal_for_channel(channel_id: &str, content: &str) -> SealedContent {
    match get_channel_key(channel_id) {
        None => SealedContent {
            content: content.to_string(),
            tag: None,
        },
        Some(key) => {
            let sealed = seal(content, &key);
            let key_id = channel_key_id(&key);
            SealedContent {
                content: sealed,
                tag: Some([
                    ENCRYPTION_TAG.to_string(),
                    NIP44_V2_SCHEME.to_string(),
                    key_id,
                ]),
            }
        }
    }
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
///
/// No production call site yet: Rust only *builds* channel-scoped events
/// today, it does not render received ones (that stays TS's job, via
/// `channelMessageCrypto.ts`'s `openChannelEvent`). Kept public and exercised
/// by this module's round-trip tests — proving `seal` byte-compatible with
/// `channelEncryption.ts` requires being able to open what it sealed — so a
/// future Rust-side reader has a tested primitive to call rather than a
/// second implementation to write.
#[allow(dead_code)]
pub fn open(payload: &str, key: &ChannelKey) -> Option<String> {
    let conversation_key = ConversationKey::new(*key);
    let bytes = BASE64.decode(payload).ok()?;
    let plaintext = decrypt_to_bytes(&conversation_key, &bytes).ok()?;
    String::from_utf8(plaintext).ok()
}

/// Serializes every test — in this module and in `events.rs` — that touches
/// the process-global `CHANNEL_KEYS` map (`sync_keys`/`get_channel_key`/
/// `seal_for_channel`): cargo runs tests in one process across multiple
/// threads, and `sync_keys` is a full replace, so two such tests running
/// concurrently would each stomp the other's keys. Mirrors
/// `managed_agents::custom_harnesses`'s `registry_test_lock` for the
/// identical shared-global-state problem.
#[cfg(test)]
pub(crate) fn channel_keys_test_lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same 32-byte key `channelMessageCrypto.test.mjs` uses (`"d".repeat(64)`
    /// as hex). Its key id, `462594b863f0be53`, was computed independently in
    /// Python (`sha256(b"buzz/channel-key-id/v1" + bytes([0xdd]*32))[:8]`) and
    /// is the cross-compat vector: any implementation of `channel_key_id`
    /// that agrees with `channelKeyId` on this key agrees with it in general,
    /// since both derivations are pure functions of (domain, key).
    const FIXED_KEY: ChannelKey = [0xdd; CHANNEL_KEY_BYTES];
    const FIXED_KEY_ID: &str = "462594b863f0be53";

    #[test]
    fn key_id_matches_the_ts_fixture_vector() {
        assert_eq!(channel_key_id(&FIXED_KEY), FIXED_KEY_ID);
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
    fn seal_for_unkeyed_channel_returns_plaintext_untouched() {
        let _guard = channel_keys_test_lock();
        sync_keys(HashMap::new());
        let sealed = seal_for_channel("no-such-channel", "public roadmap update");
        assert_eq!(sealed.content, "public roadmap update");
        assert!(sealed.tag.is_none());
    }

    #[test]
    fn seal_for_keyed_channel_encrypts_and_tags() {
        let _guard = channel_keys_test_lock();
        let mut entries = HashMap::new();
        entries.insert("engineering".to_string(), hex::encode(FIXED_KEY));
        sync_keys(entries);

        let sealed = seal_for_channel("engineering", "secret roadmap update");
        assert!(!sealed.content.contains("secret roadmap"));
        let tag = sealed.tag.expect("keyed channel must carry the marker tag");
        assert_eq!(tag[0], ENCRYPTION_TAG);
        assert_eq!(tag[1], NIP44_V2_SCHEME);
        assert_eq!(tag[2], FIXED_KEY_ID);
        assert_eq!(
            open(&sealed.content, &FIXED_KEY).unwrap(),
            "secret roadmap update"
        );

        // Clean up: other tests in this module assume no synced keys.
        sync_keys(HashMap::new());
    }

    #[test]
    fn sync_keys_replaces_rather_than_merges() {
        let _guard = channel_keys_test_lock();
        let mut first = HashMap::new();
        first.insert("design".to_string(), hex::encode(FIXED_KEY));
        sync_keys(first);
        assert!(get_channel_key("design").is_some());

        // A second sync with a different map forgets "design" entirely.
        let mut second = HashMap::new();
        second.insert(
            "engineering".to_string(),
            hex::encode([0x22; CHANNEL_KEY_BYTES]),
        );
        sync_keys(second);
        assert!(get_channel_key("design").is_none());
        assert!(get_channel_key("engineering").is_some());

        sync_keys(HashMap::new());
    }

    /// buzz#18: rotation reaches this side as a plain re-sync of one channel's
    /// key. The frontend pushes only the *sending* key
    /// (`channelKeyStore.channelKeyRecord`), so a Rust-built event written
    /// after a rotation must seal under the new epoch and carry the new key id
    /// in its marker tag — and the superseded key must be gone, because a
    /// removed member still holds it.
    #[test]
    fn seal_for_channel_follows_a_rotation_to_the_new_epoch() {
        let _guard = channel_keys_test_lock();
        let rotated: ChannelKey = [0x7c; CHANNEL_KEY_BYTES];

        let mut before = HashMap::new();
        before.insert("engineering".to_string(), hex::encode(FIXED_KEY));
        sync_keys(before);
        let old = seal_for_channel("engineering", "before the removal");
        assert_eq!(old.tag.unwrap()[2], FIXED_KEY_ID);

        let mut after = HashMap::new();
        after.insert("engineering".to_string(), hex::encode(rotated));
        sync_keys(after);
        let new = seal_for_channel("engineering", "after the removal");

        assert_eq!(new.tag.unwrap()[2], channel_key_id(&rotated));
        assert_eq!(open(&new.content, &rotated).unwrap(), "after the removal");
        // The epoch the removed member holds no longer opens what we write.
        assert!(open(&new.content, &FIXED_KEY).is_none());

        sync_keys(HashMap::new());
    }

    #[test]
    fn sync_keys_reports_malformed_entries_without_dropping_the_sync() {
        let _guard = channel_keys_test_lock();
        let mut entries = HashMap::new();
        entries.insert("good".to_string(), hex::encode(FIXED_KEY));
        entries.insert("bad".to_string(), "not-hex".to_string());
        let warnings = sync_keys(entries);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("bad"));
        assert!(get_channel_key("good").is_some());
        assert!(get_channel_key("bad").is_none());

        sync_keys(HashMap::new());
    }
}
