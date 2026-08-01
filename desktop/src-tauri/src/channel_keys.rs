//! Desktop's channel-key store: which key this process seals a given
//! channel's writes under, and where that key comes from.
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
//! ## Where the crypto lives (buzz#19)
//!
//! The primitives — `channel_key_id`, `parse_channel_key`, `seal`, `open` —
//! moved to the workspace crate `buzz-channel-crypto` so `buzz-cli`'s
//! agent-member (which cannot depend on this crate: `desktop/src-tauri` is
//! its own cargo workspace) seals and opens the identical bytes. They are
//! re-exported below, so every call site in this crate is unchanged. What
//! stays here is the part that is only true of desktop: the process-global
//! map of synced keys, and how it gets filled.
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
//! context — a headless test harness — that never renders a frontend at
//! all), but a synced key always wins once one exists for that channel — see
//! [`sync_keys`].

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

// The façade this module has always presented: every call site in this crate
// still says `channel_keys::seal` / `channel_keys::ChannelKey`, whether the
// implementation lives here or in the shared crate. `allow(unused_imports)`
// because the set forwarded is the module's interface, not a running tally of
// what today's non-test code happens to reach for — several of these are used
// only by `events_tests.rs` and `event_transport`'s `#[cfg(test)]` modules,
// and dropping them would make the façade lopsided and the next caller's
// import fail for no reason.
#[allow(unused_imports)]
pub use buzz_channel_crypto_pkg::{
    channel_key_id, open, parse_channel_key, seal, ChannelKey, CHANNEL_KEY_BYTES, ENCRYPTION_TAG,
    NIP44_V2_SCHEME,
};

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
        Some(key) => SealedContent {
            content: seal(content, &key),
            tag: Some(buzz_channel_crypto_pkg::encryption_tag(&key)),
        },
    }
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
    /// as hex). Its key id is the cross-implementation vector; the derivation
    /// itself is tested in `buzz-channel-crypto`, and re-asserted here so a
    /// dependency swap that silently changed the bytes this crate seals under
    /// fails in this crate's own test run.
    const FIXED_KEY: ChannelKey = [0xdd; CHANNEL_KEY_BYTES];
    const FIXED_KEY_ID: &str = buzz_channel_crypto_pkg::FIXED_KEY_ID_VECTOR;

    #[test]
    fn key_id_matches_the_ts_fixture_vector() {
        assert_eq!(channel_key_id(&FIXED_KEY), FIXED_KEY_ID);
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
