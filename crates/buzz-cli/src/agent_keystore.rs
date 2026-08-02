//! The agent-member's channel keystore: which channel keys this agent holds,
//! and which epoch it currently sends under (buzz#19).
//!
//! ## Where membership lives
//!
//! ADR 0001: possession of the current channel key *is* membership. The
//! sidecar (`toon-clientd`) is the identity custodian — it holds the agent's
//! nostr key, its wallet, and its payment channel, and it is the only thing
//! that can unwrap a NIP-59 gift wrap addressed to the agent. But the channel
//! keys the agent collects that way are the agent's own working state, so they
//! live here, in a file this CLI owns, and the agent does its own NIP-44
//! sealing with them. The sidecar never sees a channel key.
//!
//! ## Why a ring and not a key
//!
//! Rotation (buzz#18) issues a new key and re-wraps it to the remaining
//! members. A member that kept only the newest key would lose the ability to
//! read everything written before the rotation, so the store is a ring:
//!
//! - **index 0 is the sending key** — the epoch new writes are sealed under;
//! - **every other slot is read-only history**, kept so old messages still
//!   open.
//!
//! This is the same state model as the frontend's `buzz-channel-keys.v2`
//! (`desktop/src/shared/api/channelKeyStore.ts`) and, deliberately, the same
//! on-disk JSON — `{"version": 2, "channels": {"<id>": ["<hex>", ...]}}` —
//! so a key ring is one shape across the whole product rather than three.
//! The only addition is `identity`: an agent keystore belongs to exactly one
//! sidecar identity, and [`AgentKeystore::assert_identity`] refuses to hand a
//! second agent's keys to the wrong one.
//!
//! A newly adopted key lands at index **1**, not 0: it is readable
//! immediately, but it does not become the sending key until the channel's
//! validated admin list names its key id (see [`AgentKeystore::promote`], the
//! port of `promoteChannelKey`/`reconcileChannelKeyEpochs`). That ordering is
//! what stops an admin's pre-announcement wrap — or a replayed old one — from
//! silently redirecting what the agent writes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use buzz_channel_crypto::{channel_key_id, parse_channel_key, ChannelKey};
use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// Matches `channelKeyStore.ts`'s `MAX_KEYS_PER_CHANNEL`. A ring at the cap
/// drops its oldest key, which is the one least likely to still be needed.
const MAX_KEYS_PER_CHANNEL: usize = 16;

/// The on-disk store version. Shares the frontend's number because it shares
/// the frontend's shape.
const STORE_VERSION: u32 = 2;

/// Default keystore file name under the config dir.
const KEYSTORE_FILE: &str = "agent-channel-keys.json";

/// Serialized form. `channels` is a `BTreeMap` so the file is stable across
/// writes — a keystore that reorders itself on every save is unreadable in a
/// diff and noisy in a backup.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    /// The sidecar identity (hex nostr pubkey) these keys were delivered to.
    /// Absent in a store written before this field existed, and absent is
    /// treated as "belongs to whoever opens it".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    #[serde(default)]
    channels: BTreeMap<String, Vec<String>>,
    /// channel id → the creator pubkey this agent pinned as that channel's
    /// admin-chain root. Mirrors `channelAdminListStore.ts`'s
    /// `pinnedCreators`, persisted because a CLI is a fresh process every
    /// time and a TOFU pin that forgets itself between runs protects nothing.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    creators: BTreeMap<String, String>,
}

/// An open keystore. Mutations are in memory until [`AgentKeystore::save`].
#[derive(Debug, Clone)]
pub struct AgentKeystore {
    path: PathBuf,
    identity: Option<String>,
    /// channel id → ring, index 0 = sending key.
    channels: BTreeMap<String, Vec<ChannelKey>>,
    /// channel id → pinned admin-chain root.
    creators: BTreeMap<String, String>,
}

/// What [`AgentKeystore::adopt`] did with a key, so callers can report it
/// without re-deriving the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adoption {
    /// First key for this channel — the agent is now a member, and this is
    /// also the sending key.
    FirstKey,
    /// Added to the ring as readable history, behind the current sending key.
    Added,
    /// Already held. Notably *not* moved to the front: a replayed wrap for a
    /// superseded epoch must not redirect what the agent writes.
    AlreadyHeld,
}

impl AgentKeystore {
    /// Resolve the keystore path: an explicit override wins, else
    /// `<config-dir>/buzz/agent-channel-keys.json`.
    ///
    /// One file belongs to one agent. A second agent on the same host runs
    /// its own sidecar and must be pointed at its own path (`--keystore` /
    /// `BUZZ_AGENT_KEYSTORE`); [`Self::assert_identity`] turns the mistake
    /// into an error rather than a cross-wired key.
    pub fn resolve_path(override_path: Option<&str>) -> Result<PathBuf, CliError> {
        if let Some(path) = override_path {
            return Ok(PathBuf::from(path));
        }
        let config = dirs::config_dir().ok_or_else(|| {
            CliError::Other(
                "could not resolve a platform config directory for the agent keystore — \
pass --keystore or set BUZZ_AGENT_KEYSTORE"
                    .to_string(),
            )
        })?;
        Ok(config.join("buzz").join(KEYSTORE_FILE))
    }

    /// Open the keystore at `path`, or start an empty one when the file does
    /// not exist yet — a first run is not an error.
    pub fn open(path: PathBuf) -> Result<Self, CliError> {
        if !path.exists() {
            return Ok(Self {
                path,
                identity: None,
                channels: BTreeMap::new(),
                creators: BTreeMap::new(),
            });
        }
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| CliError::Other(format!("failed to read {}: {e}", path.display())))?;
        let file: StoreFile = serde_json::from_str(&raw).map_err(|e| {
            CliError::Other(format!(
                "failed to parse the agent keystore at {}: {e}",
                path.display()
            ))
        })?;
        if file.version != STORE_VERSION {
            return Err(CliError::Other(format!(
                "agent keystore at {} is version {} — this build understands version {}",
                path.display(),
                file.version,
                STORE_VERSION
            )));
        }

        let mut channels = BTreeMap::new();
        for (channel_id, ring) in file.channels {
            let parsed = parse_ring(&ring);
            if !parsed.is_empty() {
                channels.insert(channel_id, parsed);
            }
        }
        Ok(Self {
            path,
            identity: file.identity,
            channels,
            creators: file.creators,
        })
    }

    /// Bind the store to a sidecar identity, or refuse when it already
    /// belongs to a different one.
    ///
    /// Adopting a key wrapped to identity B into identity A's store would
    /// leave the agent able to *read* a channel it can never be seen posting
    /// in — and, worse, would make one host's two agents look like one
    /// member. Cheap to check, confusing to debug otherwise.
    pub fn assert_identity(&mut self, pubkey: &str) -> Result<(), CliError> {
        let pubkey = pubkey.trim().to_ascii_lowercase();
        match self.identity.as_deref() {
            Some(existing) if existing != pubkey => Err(CliError::Usage(format!(
                "the agent keystore at {} belongs to identity {existing}, but this sidecar is \
{pubkey} — point --keystore / BUZZ_AGENT_KEYSTORE at this agent's own file",
                self.path.display()
            ))),
            _ => {
                self.identity = Some(pubkey);
                Ok(())
            }
        }
    }

    /// The key this agent seals new writes to `channel_id` under, or `None`
    /// when it holds none — which is exactly "not a member".
    pub fn sending_key(&self, channel_id: &str) -> Option<ChannelKey> {
        self.channels.get(channel_id)?.first().copied()
    }

    /// Every key held for `channel_id`, newest-sending first. Used to open
    /// history across rotations.
    pub fn ring(&self, channel_id: &str) -> &[ChannelKey] {
        self.channels
            .get(channel_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Channels this agent holds any key for.
    pub fn channels(&self) -> impl Iterator<Item = &String> {
        self.channels.keys()
    }

    /// Add `key` to `channel_id`'s ring. Mirrors `adoptChannelKey`.
    ///
    /// A key for a channel the agent already has one for lands at index **1**
    /// — readable at once, but not the sending key until [`Self::promote`]
    /// says so. `adoptChannelKey`'s `makeCurrent` option is deliberately not
    /// ported: it exists for the client that *performs* a rotation and
    /// therefore knows the new key is current before anyone announces it. An
    /// agent-member is never that client; it learns which epoch is current
    /// from the validated admin list and nowhere else.
    pub fn adopt(&mut self, channel_id: &str, key: ChannelKey) -> Adoption {
        let ring = self.channels.entry(channel_id.to_string()).or_default();
        if ring.is_empty() {
            ring.push(key);
            return Adoption::FirstKey;
        }
        if ring.contains(&key) {
            return Adoption::AlreadyHeld;
        }
        ring.insert(1, key);
        ring.truncate(MAX_KEYS_PER_CHANNEL);
        Adoption::Added
    }

    /// Make the held key named by `key_id` this channel's sending key.
    /// Mirrors `promoteChannelKey`: promote-only, and a no-op when the key id
    /// is unknown or already at the front.
    pub fn promote(&mut self, channel_id: &str, key_id: &str) -> bool {
        let Some(ring) = self.channels.get_mut(channel_id) else {
            return false;
        };
        let Some(index) = ring.iter().position(|key| channel_key_id(key) == key_id) else {
            return false;
        };
        if index == 0 {
            return false;
        }
        let key = ring.remove(index);
        ring.insert(0, key);
        true
    }

    /// The admin-chain root this agent pinned for `channel_id`, if any.
    ///
    /// Trust-on-first-use: the first root that successfully admitted this
    /// agent to a channel is the root forever. Without the pin, an attacker
    /// who backdates a self-naming kind:39100 for the same channel id could
    /// re-root the chain on a later sweep and hand the agent a key of their
    /// own — the exact hole `resolveChannelAdminList`'s creator argument
    /// exists to close.
    pub fn pinned_creator(&self, channel_id: &str) -> Option<&str> {
        self.creators.get(channel_id).map(String::as_str)
    }

    /// Pin `creator` as `channel_id`'s root, first write wins.
    pub fn pin_creator(&mut self, channel_id: &str, creator: &str) {
        self.creators
            .entry(channel_id.to_string())
            .or_insert_with(|| creator.trim().to_ascii_lowercase());
    }

    /// Persist to disk, creating parent directories, with owner-only
    /// permissions on unix. These bytes are membership: anyone who can read
    /// the file can read the channel.
    pub fn save(&self) -> Result<(), CliError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::Other(format!("failed to create {}: {e}", parent.display()))
            })?;
        }
        let file = StoreFile {
            version: STORE_VERSION,
            identity: self.identity.clone(),
            channels: self
                .channels
                .iter()
                .map(|(id, ring)| (id.clone(), ring.iter().map(hex::encode).collect()))
                .collect(),
            creators: self.creators.clone(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| CliError::Other(format!("failed to serialize the agent keystore: {e}")))?;
        write_private(&self.path, &json)
    }

    /// Where this store lives, for messages that must name the file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Parse a serialized ring, dropping anything that is not 32 bytes of hex and
/// de-duplicating. Mirrors `parseRing` — a corrupted entry costs that entry,
/// not the whole channel.
fn parse_ring(entries: &[String]) -> Vec<ChannelKey> {
    let mut ring: Vec<ChannelKey> = Vec::new();
    for entry in entries {
        if let Some(key) = parse_channel_key(entry) {
            if !ring.contains(&key) {
                ring.push(key);
            }
        }
    }
    ring.truncate(MAX_KEYS_PER_CHANNEL);
    ring
}

#[cfg(unix)]
fn write_private(path: &Path, contents: &str) -> Result<(), CliError> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| CliError::Other(format!("failed to write {}: {e}", path.display())))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| CliError::Other(format!("failed to write {}: {e}", path.display())))
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &str) -> Result<(), CliError> {
    std::fs::write(path, contents)
        .map_err(|e| CliError::Other(format!("failed to write {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: ChannelKey = [0xaa; 32];
    const KEY_B: ChannelKey = [0xbb; 32];
    const KEY_C: ChannelKey = [0xcc; 32];

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(KEYSTORE_FILE);
        (dir, path)
    }

    #[test]
    fn a_missing_file_opens_as_an_empty_store() {
        let (_dir, path) = scratch();
        let store = AgentKeystore::open(path).unwrap();
        assert!(store.sending_key("engineering").is_none());
        assert_eq!(store.ring("engineering").len(), 0);
    }

    #[test]
    fn the_first_key_becomes_the_sending_key() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path).unwrap();
        assert_eq!(store.adopt("engineering", KEY_A), Adoption::FirstKey);
        assert_eq!(store.sending_key("engineering"), Some(KEY_A));
    }

    #[test]
    fn a_later_key_is_readable_but_not_yet_sending() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path).unwrap();
        store.adopt("engineering", KEY_A);
        assert_eq!(store.adopt("engineering", KEY_B), Adoption::Added);

        assert_eq!(store.sending_key("engineering"), Some(KEY_A));
        assert_eq!(store.ring("engineering"), &[KEY_A, KEY_B]);
        assert!(
            store
                .ring("engineering")
                .iter()
                .any(|key| channel_key_id(key) == channel_key_id(&KEY_B)),
            "the new epoch opens messages already, before it is promoted"
        );
    }

    #[test]
    fn promotion_makes_the_named_epoch_the_sending_key() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path).unwrap();
        store.adopt("engineering", KEY_A);
        store.adopt("engineering", KEY_B);

        assert!(store.promote("engineering", &channel_key_id(&KEY_B)));
        assert_eq!(store.sending_key("engineering"), Some(KEY_B));
        assert_eq!(
            store.ring("engineering"),
            &[KEY_B, KEY_A],
            "the superseded epoch stays readable behind the new one"
        );
    }

    #[test]
    fn promotion_is_a_no_op_for_an_unknown_or_leading_key() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path).unwrap();
        store.adopt("engineering", KEY_A);
        assert!(!store.promote("engineering", &channel_key_id(&KEY_A)));
        assert!(!store.promote("engineering", &channel_key_id(&KEY_C)));
        assert!(!store.promote("no-such-channel", &channel_key_id(&KEY_A)));
    }

    #[test]
    fn a_replayed_wrap_cannot_move_a_superseded_key_back_to_the_front() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path).unwrap();
        store.adopt("engineering", KEY_A);
        store.adopt("engineering", KEY_B);
        store.promote("engineering", &channel_key_id(&KEY_B));

        // The pre-rotation key arrives again, e.g. a relay replaying an old
        // gift wrap.
        assert_eq!(store.adopt("engineering", KEY_A), Adoption::AlreadyHeld);
        assert_eq!(store.sending_key("engineering"), Some(KEY_B));
    }

    #[test]
    fn the_ring_is_capped_and_drops_the_oldest() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path).unwrap();
        store.adopt("engineering", [0x00; 32]);
        for n in 1..40u8 {
            store.adopt("engineering", [n; 32]);
        }
        assert_eq!(store.ring("engineering").len(), MAX_KEYS_PER_CHANNEL);
        assert_eq!(
            store.sending_key("engineering"),
            Some([0x00; 32]),
            "the sending key survives a flood of new epochs — only a promotion moves it"
        );
        assert_eq!(
            store.ring("engineering").last(),
            Some(&[25u8; 32]),
            "the sending key plus the 15 most recent arrivals; older history falls off"
        );
    }

    #[test]
    fn a_saved_store_round_trips_and_keeps_ring_order() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path.clone()).unwrap();
        store.adopt("engineering", KEY_A);
        store.adopt("engineering", KEY_B);
        store.promote("engineering", &channel_key_id(&KEY_B));
        store.adopt("design", KEY_C);
        store.assert_identity("AB".repeat(32).as_str()).unwrap();
        store.save().unwrap();

        let reopened = AgentKeystore::open(path.clone()).unwrap();
        assert_eq!(reopened.ring("engineering"), &[KEY_B, KEY_A]);
        assert_eq!(reopened.sending_key("design"), Some(KEY_C));

        // Same on-disk shape as the frontend's `buzz-channel-keys.v2`.
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["version"], 2);
        assert_eq!(raw["identity"], "ab".repeat(32));
        assert_eq!(
            raw["channels"]["engineering"],
            serde_json::json!([hex::encode(KEY_B), hex::encode(KEY_A)])
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_saved_store_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path.clone()).unwrap();
        store.adopt("engineering", KEY_A);
        store.save().unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "channel keys are membership");
    }

    #[test]
    fn a_store_bound_to_another_identity_is_refused() {
        let (_dir, path) = scratch();
        let mut store = AgentKeystore::open(path.clone()).unwrap();
        store.assert_identity(&"11".repeat(32)).unwrap();
        store.save().unwrap();

        let mut reopened = AgentKeystore::open(path).unwrap();
        let err = reopened.assert_identity(&"22".repeat(32)).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
        // Re-binding to the same identity is fine.
        assert!(reopened.assert_identity(&"11".repeat(32)).is_ok());
    }

    #[test]
    fn a_corrupt_ring_entry_costs_only_that_entry() {
        let (_dir, path) = scratch();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 2,
                "channels": {
                    "engineering": [hex::encode(KEY_A), "not-hex", hex::encode(KEY_B)]
                }
            })
            .to_string(),
        )
        .unwrap();

        let store = AgentKeystore::open(path).unwrap();
        assert_eq!(store.ring("engineering"), &[KEY_A, KEY_B]);
    }

    #[test]
    fn an_unknown_store_version_is_an_error_not_a_silent_wipe() {
        let (_dir, path) = scratch();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"version": 99, "channels": {}}"#).unwrap();
        assert!(AgentKeystore::open(path).is_err());
    }
}
