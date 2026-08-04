//! Fleet identity: persisted agent → BIP-44 account-index registry (buzz#79).
//!
//! `docs/adr/0005` established that `toon-clientd` derives an agent's TOON
//! payment key from the *owner's* seed at a `BUZZ_TOON_ACCOUNT_INDEX` — this
//! module is the source of truth for which index belongs to which agent, so
//! that N managed agents on one host each get a stable, non-colliding index
//! across creation, restarts, and deletion (buzz#79's job per that ADR).
//!
//! Index `0` is reserved for the desktop's own owner identity (see
//! `desktop/src/features/onboarding/toon/toonOnboardingIdentity.ts`'s
//! `WIZARD_ACCOUNT_INDEX`), so managed-agent indices start at 1.
//!
//! The registry (`agents/account-index-registry.json`) is append-only:
//! deleting an agent tombstones its entry (`deleted_at` set) rather than
//! removing it, so the index is never reassigned and the agent's TOON
//! collateral — derivable from the owner's seed at that index — stays
//! reclaimable. See `docs/adr/0006-fleet-identity-account-index-registry.md`
//! for the scan-based recovery procedure if this file is ever lost.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::managed_agents::managed_agents_base_dir;
use crate::util::now_iso;

/// Managed-agent indices start at 1 — index 0 is reserved for the desktop's
/// own owner identity (`WIZARD_ACCOUNT_INDEX` in
/// `toonOnboardingIdentity.ts`) and is never assigned to an agent.
const FIRST_AGENT_ACCOUNT_INDEX: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountIndexEntry {
    pub pubkey: String,
    pub account_index: u32,
    /// Display-only context for a human reading the JSON by hand during
    /// recovery — never used for lookups.
    #[serde(default)]
    pub agent_name: String,
    pub assigned_at: String,
    /// Set when the owning agent is deleted. The entry itself is retained —
    /// see the module doc — so this is the only field deletion touches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

/// Serializes every read-modify-write of the registry file within this
/// process. Cross-process contention (two desktop instances) is an accepted
/// risk here, matching `managed-agents.json`'s own protection level — only
/// `SecretStore`'s OS-keychain blob uses a heavier cross-process file lock,
/// because that blob is shared by name across otherwise-unrelated builds.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

fn account_index_registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_agents_base_dir(app)?.join("account-index-registry.json"))
}

/// Pure load: parses the registry file at `path`, or returns an empty
/// registry when the file does not exist yet (fresh install / pre-buzz#79
/// upgrade). Factored out from the `AppHandle`-taking wrapper so the
/// assignment/tombstone logic below is testable without a live Tauri app,
/// mirroring `storage.rs`'s split between path resolution and pure I/O.
fn load_registry_from_path(path: &Path) -> Result<Vec<AccountIndexEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("failed to read account index registry: {error}"))?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse account index registry: {error}"))
}

fn save_registry_to_path(path: &Path, entries: &[AccountIndexEntry]) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(entries)
        .map_err(|error| format!("failed to serialize account index registry: {error}"))?;
    crate::managed_agents::atomic_write_json_restricted(path, &payload)
}

/// Assign `pubkey` the next never-before-used index, or return its existing
/// index if one is already on file (idempotent — safe to call from every
/// spawn as a lazy-migration path for agents created before this registry
/// existed). Mutates `entries` in place and returns the index.
fn assign_index_in(entries: &mut Vec<AccountIndexEntry>, pubkey: &str, agent_name: &str) -> u32 {
    if let Some(existing) = entries.iter().find(|entry| entry.pubkey == pubkey) {
        return existing.account_index;
    }
    let next_index = entries
        .iter()
        .map(|entry| entry.account_index)
        .max()
        .map_or(FIRST_AGENT_ACCOUNT_INDEX, |max| max + 1);
    entries.push(AccountIndexEntry {
        pubkey: pubkey.to_string(),
        account_index: next_index,
        agent_name: agent_name.to_string(),
        assigned_at: now_iso(),
        deleted_at: None,
    });
    next_index
}

/// Pure lookup: `pubkey`'s already-assigned index, or `None` if it has never
/// been assigned one (never mutates `entries` — unlike [`assign_index_in`],
/// this must not conjure an index just because a caller asked to look).
fn find_index_in(entries: &[AccountIndexEntry], pubkey: &str) -> Option<u32> {
    entries
        .iter()
        .find(|entry| entry.pubkey == pubkey)
        .map(|entry| entry.account_index)
}

/// Tombstone `pubkey`'s entry in place. Returns `true` if an entry was found
/// (tombstoned or already tombstoned); `false` if `pubkey` has no entry
/// (agent deleted before it ever spawned under this registry).
fn tombstone_index_in(entries: &mut [AccountIndexEntry], pubkey: &str) -> bool {
    let Some(entry) = entries.iter_mut().find(|entry| entry.pubkey == pubkey) else {
        return false;
    };
    if entry.deleted_at.is_none() {
        entry.deleted_at = Some(now_iso());
    }
    true
}

/// Assign (or return the already-assigned) account index for `pubkey`,
/// persisting the registry. See [`assign_index_in`] for the assignment rule.
pub fn assign_account_index(
    app: &AppHandle,
    pubkey: &str,
    agent_name: &str,
) -> Result<u32, String> {
    let path = account_index_registry_path(app)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_registry_from_path(&path)?;
    let index = assign_index_in(&mut entries, pubkey, agent_name);
    save_registry_to_path(&path, &entries)?;
    Ok(index)
}

/// Look up `pubkey`'s already-assigned account index without assigning one
/// (buzz#74: the provisioning flow needs to derive the agent's payment
/// address before it can fund it, and `create_managed_agent` already
/// assigns the index synchronously at creation — this is a read, not a
/// fallback path). `None` when `pubkey` has no entry yet, which the caller
/// should treat as "not provisionable yet" rather than an error.
pub fn find_account_index(app: &AppHandle, pubkey: &str) -> Result<Option<u32>, String> {
    let path = account_index_registry_path(app)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries = load_registry_from_path(&path)?;
    Ok(find_index_in(&entries, pubkey))
}

/// Tombstone `pubkey`'s registry entry on agent deletion. The entry (and its
/// index) is retained, never removed — see the module doc. No-op if
/// `pubkey` was never assigned an index.
pub fn tombstone_account_index(app: &AppHandle, pubkey: &str) -> Result<(), String> {
    let path = account_index_registry_path(app)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_registry_from_path(&path)?;
    if tombstone_index_in(&mut entries, pubkey) {
        save_registry_to_path(&path, &entries)?;
    }
    Ok(())
}

/// [`tombstone_account_index`], but best-effort: the caller (agent deletion)
/// has already committed to removing the agent record by the time this
/// runs, so a registry write failure here must not re-fail — it only logs.
pub fn tombstone_account_index_best_effort(app: &AppHandle, pubkey: &str) {
    if let Err(error) = tombstone_account_index(app, pubkey) {
        eprintln!(
            "buzz-desktop: failed to tombstone account index for deleted agent {pubkey}: {error}"
        );
    }
}

/// Assign `record`'s account index (idempotent per pubkey — a lazy-migration
/// path for agents created before this registry existed, see the module
/// doc) and set `BUZZ_TOON_ACCOUNT_INDEX` on the about-to-spawn `command`.
/// Best-effort: only logs on failure, since the index is load-bearing only
/// once `BUZZ_TRANSPORT=toon` is also configured, and `BUZZ_TOON_ACCOUNT_INDEX`
/// is reserved (`env_vars::RESERVED_ENV_KEYS`) so a user override can never
/// collide two agents' payment identities regardless of this call's outcome.
pub fn apply_account_index_env(
    command: &mut std::process::Command,
    app: &AppHandle,
    record: &crate::managed_agents::ManagedAgentRecord,
) {
    match assign_account_index(app, &record.pubkey, &record.name) {
        Ok(index) => {
            command.env("BUZZ_TOON_ACCOUNT_INDEX", index.to_string());
        }
        Err(error) => {
            eprintln!(
                "buzz-desktop: failed to assign TOON account index for agent {} ({}): {error}",
                record.name, record.pubkey
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assign_starts_at_one_reserving_zero_for_owner() {
        let mut entries = Vec::new();
        let index = assign_index_in(&mut entries, "agent-a", "Agent A");
        assert_eq!(index, FIRST_AGENT_ACCOUNT_INDEX);
        assert_ne!(index, 0, "index 0 is reserved for the owner identity");
    }

    #[test]
    fn assign_gives_distinct_increasing_indices() {
        let mut entries = Vec::new();
        let a = assign_index_in(&mut entries, "agent-a", "Agent A");
        let b = assign_index_in(&mut entries, "agent-b", "Agent B");
        assert_ne!(a, b);
        assert_eq!(b, a + 1);
    }

    #[test]
    fn assign_is_idempotent_per_pubkey() {
        let mut entries = Vec::new();
        let first = assign_index_in(&mut entries, "agent-a", "Agent A");
        let second = assign_index_in(&mut entries, "agent-a", "Agent A (renamed)");
        assert_eq!(first, second);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn find_returns_none_for_an_unassigned_pubkey_without_mutating() {
        let entries = Vec::new();
        assert_eq!(find_index_in(&entries, "agent-a"), None);
    }

    #[test]
    fn find_returns_the_assigned_index() {
        let mut entries = Vec::new();
        let a = assign_index_in(&mut entries, "agent-a", "Agent A");
        assert_eq!(find_index_in(&entries, "agent-a"), Some(a));
    }

    #[test]
    fn find_still_returns_a_tombstoned_agents_index() {
        let mut entries = Vec::new();
        let a = assign_index_in(&mut entries, "agent-a", "Agent A");
        tombstone_index_in(&mut entries, "agent-a");
        assert_eq!(find_index_in(&entries, "agent-a"), Some(a));
    }

    #[test]
    fn tombstoned_index_is_never_reused() {
        let mut entries = Vec::new();
        let a = assign_index_in(&mut entries, "agent-a", "Agent A");
        assert!(tombstone_index_in(&mut entries, "agent-a"));
        // A brand-new agent must not receive the tombstoned agent's index.
        let b = assign_index_in(&mut entries, "agent-b", "Agent B");
        assert_ne!(a, b);
        // The tombstoned entry itself is retained, not removed.
        let entry = entries.iter().find(|e| e.pubkey == "agent-a").unwrap();
        assert_eq!(entry.account_index, a);
        assert!(entry.deleted_at.is_some());
    }

    #[test]
    fn tombstone_of_unknown_pubkey_is_a_no_op() {
        let mut entries = Vec::new();
        assign_index_in(&mut entries, "agent-a", "Agent A");
        assert!(!tombstone_index_in(&mut entries, "never-assigned"));
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn tombstone_is_idempotent() {
        let mut entries = Vec::new();
        assign_index_in(&mut entries, "agent-a", "Agent A");
        assert!(tombstone_index_in(&mut entries, "agent-a"));
        let first_deleted_at = entries[0].deleted_at.clone();
        assert!(tombstone_index_in(&mut entries, "agent-a"));
        assert_eq!(entries[0].deleted_at, first_deleted_at);
    }

    #[test]
    fn load_from_missing_path_is_an_empty_registry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account-index-registry.json");
        let entries = load_registry_from_path(&path).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account-index-registry.json");
        let mut entries = Vec::new();
        assign_index_in(&mut entries, "agent-a", "Agent A");
        assign_index_in(&mut entries, "agent-b", "Agent B");
        tombstone_index_in(&mut entries, "agent-a");
        save_registry_to_path(&path, &entries).unwrap();

        let reloaded = load_registry_from_path(&path).unwrap();
        assert_eq!(reloaded, entries);
    }

    #[test]
    fn two_agents_derive_distinct_stable_indices_across_a_simulated_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account-index-registry.json");

        // "App boot 1": both agents created.
        let mut entries = load_registry_from_path(&path).unwrap();
        let a1 = assign_index_in(&mut entries, "agent-a", "Agent A");
        let b1 = assign_index_in(&mut entries, "agent-b", "Agent B");
        save_registry_to_path(&path, &entries).unwrap();
        assert_ne!(a1, b1);

        // "App restart": registry reloaded from disk, indices looked up again.
        let mut entries = load_registry_from_path(&path).unwrap();
        let a2 = assign_index_in(&mut entries, "agent-a", "Agent A");
        let b2 = assign_index_in(&mut entries, "agent-b", "Agent B");
        assert_eq!(a1, a2);
        assert_eq!(b1, b2);
    }
}
