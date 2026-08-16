//! The workflow agent's resume state: per-channel walk cursors plus the set of
//! event ids already evaluated (buzz#21).
//!
//! ## Why "evaluated", not "indexed"
//!
//! [`crate::search_agent`]'s tail walk re-fetches the head page every cycle
//! (`since` is inclusive in NIP-01, so the newest known event comes back every
//! poll) and relies on `SearchIndex::contains` to skip what it already has.
//! This agent has no document store to ask that question of — a reply, once
//! sent, is not content the agent needs to keep around — so it keeps the
//! narrowest thing that answers the same question: the event ids a cycle has
//! already run trigger evaluation against. Without it, the boundary event
//! `since` re-delivers every cycle would be evaluated — and, if it matched, a
//! workflow would re-fire on it — forever.
//!
//! This is also where issue #21's "at most once across restarts" cursor
//! semantics live: [`WorkflowState::save`] commits the evaluated set and the
//! walk cursors in the same atomic write as
//! [`crate::search_index::SearchIndex::save`] does for documents, so a crash
//! mid-cycle costs a repeated cycle (already-evaluated ids are skipped again,
//! cheaply), never a skipped one.
//!
//! v1 does not prune the evaluated set — like the search index's document
//! store, it is unbounded for the lifetime of the file. That is an accepted
//! trade for a first version scoped to "one workflow, one channel, a demo";
//! a follow-up can prune ids older than the oldest cursor's backfill boundary
//! once there is a second caller to validate the bound against.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CliError;
use crate::search_index::ChannelCursor;

/// On-disk format version.
const STATE_VERSION: u32 = 1;

/// Default state file name under the agent's data dir.
const STATE_FILE: &str = "workflow-agent-state.json";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateFile {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    #[serde(default)]
    channels: BTreeMap<String, ChannelCursor>,
    #[serde(default)]
    evaluated: BTreeSet<String>,
    /// `schedule:` trigger last-fired times, unix seconds, keyed by workflow
    /// name (buzz#22) — a schedule workflow has no channel cursor to hang
    /// this off of, since it is never driven by a channel walk.
    #[serde(default)]
    scheduled: BTreeMap<String, u64>,
    /// The `reaction_added` trigger's own forward-tail cursor per channel
    /// (buzz#52) — kept separate from `channels` (the message cursor)
    /// because the reaction pass walks a different kind on its own
    /// schedule; see `crate::workflow_agent`'s reaction pass.
    #[serde(default)]
    reaction_cursors: BTreeMap<String, ChannelCursor>,
    /// Recently-seen message ids per channel, newest first and capped to the
    /// page size (buzz#52) — the `#e` scope a reaction fetch is bounded to.
    /// See `docs/workflow-agent-parity.md`'s `reaction_added` row for why a
    /// reaction fetch cannot simply scope by channel.
    #[serde(default)]
    reaction_targets: BTreeMap<String, Vec<String>>,
    /// The `admin_added` trigger's previous-cycle admin-list fold per
    /// channel (buzz#52) — an entry's *absence* means "never observed",
    /// which the admin-diff pass treats differently from "observed with no
    /// admins": the first observation of a channel seeds this without
    /// firing (there is no genuine "just joined" to report for admins that
    /// were already there), matching a schedule trigger's "no retroactive
    /// fire" (buzz#22).
    #[serde(default)]
    admin_snapshots: BTreeMap<String, BTreeSet<String>>,
}

/// The agent's resume state: one file, one identity, written atomically.
#[derive(Debug)]
pub struct WorkflowState {
    path: PathBuf,
    identity: Option<String>,
    cursors: BTreeMap<String, ChannelCursor>,
    evaluated: BTreeSet<String>,
    scheduled: BTreeMap<String, u64>,
    reaction_cursors: BTreeMap<String, ChannelCursor>,
    reaction_targets: BTreeMap<String, Vec<String>>,
    admin_snapshots: BTreeMap<String, BTreeSet<String>>,
}

impl WorkflowState {
    /// Resolve the state path: an explicit override wins, else
    /// `<data-dir>/buzz/workflow-agent-state.json` — the data dir, not the
    /// config dir the keystore uses, because this file is regenerable resume
    /// state: delete it and the agent starts from the head of every held
    /// channel, evaluating (not re-firing on — see the module doc) the same
    /// history again.
    pub fn resolve_path(override_path: Option<&str>) -> Result<PathBuf, CliError> {
        if let Some(path) = override_path {
            return Ok(PathBuf::from(path));
        }
        let data = dirs::data_dir().ok_or_else(|| {
            CliError::Other(
                "could not resolve a platform data directory for the workflow agent state — \
pass --state or set BUZZ_WORKFLOW_STATE"
                    .to_string(),
            )
        })?;
        Ok(data.join("buzz").join(STATE_FILE))
    }

    /// Open the state at `path`, or start empty — a missing, corrupt, or
    /// future-versioned file is never fatal (mirrors
    /// [`crate::search_index::SearchIndex::open`]): the worst case is
    /// re-evaluating history the agent already saw, not a runner that refuses
    /// to start because its resume cache is unreadable.
    pub fn open(path: PathBuf) -> Self {
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StateFile>(&raw).ok())
            .filter(|file| file.version == STATE_VERSION);

        match file {
            Some(file) => Self {
                path,
                identity: file.identity,
                cursors: file.channels,
                evaluated: file.evaluated,
                scheduled: file.scheduled,
                reaction_cursors: file.reaction_cursors,
                reaction_targets: file.reaction_targets,
                admin_snapshots: file.admin_snapshots,
            },
            None => Self {
                path,
                identity: None,
                cursors: BTreeMap::new(),
                evaluated: BTreeSet::new(),
                scheduled: BTreeMap::new(),
                reaction_cursors: BTreeMap::new(),
                reaction_targets: BTreeMap::new(),
                admin_snapshots: BTreeMap::new(),
            },
        }
    }

    /// Bind the state to a sidecar identity, or refuse when it already
    /// belongs to a different one — same guard as the keystore and the search
    /// index, for the same reason: one agent's evaluated-event bookkeeping
    /// must not silently answer for another agent's identity.
    pub fn assert_identity(&mut self, pubkey: &str) -> Result<(), CliError> {
        let pubkey = pubkey.trim().to_ascii_lowercase();
        match self.identity.as_deref() {
            Some(existing) if existing != pubkey => Err(CliError::Usage(format!(
                "the workflow agent state at {} belongs to identity {existing}, but this sidecar \
is {pubkey} — point --state / BUZZ_WORKFLOW_STATE at this agent's own file",
                self.path.display()
            ))),
            _ => {
                self.identity = Some(pubkey);
                Ok(())
            }
        }
    }

    pub fn cursor(&self, channel_id: &str) -> ChannelCursor {
        self.cursors.get(channel_id).cloned().unwrap_or_default()
    }

    pub fn set_cursor(&mut self, channel_id: &str, cursor: ChannelCursor) {
        self.cursors.insert(channel_id.to_string(), cursor);
    }

    /// Has this event id already been through a full evaluation pass?
    pub fn is_evaluated(&self, event_id: &str) -> bool {
        self.evaluated.contains(event_id)
    }

    /// Record that `event_id` has been evaluated — whether or not it fired a
    /// workflow, and whether or not the resulting action (if any) was
    /// actually sent. See the module doc: a dropped action is not retried, so
    /// its trigger is not re-evaluated either.
    pub fn mark_evaluated(&mut self, event_id: &str) {
        self.evaluated.insert(event_id.to_string());
    }

    /// When `workflow_name`'s schedule last fired, in unix seconds — `None`
    /// if it has never fired (including "never fired *by this state file*",
    /// e.g. a fresh install or a renamed workflow), which
    /// [`crate::workflow_agent::is_schedule_due`] treats as "due only at the
    /// next tick after now", never retroactively (see that function's doc).
    pub fn last_fired(&self, workflow_name: &str) -> Option<u64> {
        self.scheduled.get(workflow_name).copied()
    }

    /// Record that `workflow_name`'s schedule fired at `at` (unix seconds).
    /// Recorded whether the resulting action was sent, dropped, or refused —
    /// mirroring [`Self::mark_evaluated`]'s "not queued for a later cycle"
    /// rule: a schedule slot that already fired is not retried.
    pub fn set_last_fired(&mut self, workflow_name: &str, at: u64) {
        self.scheduled.insert(workflow_name.to_string(), at);
    }

    /// The `reaction_added` trigger's forward-tail cursor for `channel_id`
    /// (buzz#52) — separate from [`Self::cursor`], the message cursor.
    pub fn reaction_cursor(&self, channel_id: &str) -> ChannelCursor {
        self.reaction_cursors
            .get(channel_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_reaction_cursor(&mut self, channel_id: &str, cursor: ChannelCursor) {
        self.reaction_cursors.insert(channel_id.to_string(), cursor);
    }

    /// The bounded window of recently-seen message ids for `channel_id` —
    /// what a reaction fetch's `#e` filter is scoped to (buzz#52).
    pub fn reaction_targets(&self, channel_id: &str) -> &[String] {
        self.reaction_targets
            .get(channel_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Record `event_id` as a recently-seen message in `channel_id`: moved
    /// to the front (newest first, deduplicated) and truncated to `cap`
    /// entries. `cap` is the caller's page size — see
    /// `crate::workflow_agent`'s module doc's "buzz#52" section for why the
    /// window is bounded that way.
    pub fn observe_reaction_target(&mut self, channel_id: &str, event_id: &str, cap: usize) {
        let ids = self
            .reaction_targets
            .entry(channel_id.to_string())
            .or_default();
        ids.retain(|id| id != event_id);
        ids.insert(0, event_id.to_string());
        ids.truncate(cap.max(1));
    }

    /// `channel_id`'s admin set as of the last `admin_added` pass, or `None`
    /// if this channel has never been observed by one (buzz#52) — see the
    /// field's doc on [`StateFile::admin_snapshots`] for why that distinction
    /// matters.
    pub fn admin_snapshot(&self, channel_id: &str) -> Option<&BTreeSet<String>> {
        self.admin_snapshots.get(channel_id)
    }

    /// Replace `channel_id`'s admin snapshot — recorded every cycle the
    /// admin-diff pass runs, whether or not it fired, mirroring
    /// [`Self::mark_evaluated`]'s "not queued for a later cycle" rule.
    pub fn set_admin_snapshot(&mut self, channel_id: &str, admins: BTreeSet<String>) {
        self.admin_snapshots.insert(channel_id.to_string(), admins);
    }

    /// Write cursors and the evaluated set to disk in one atomic replacement.
    /// Temp file in the same directory, owner-only, `fsync`, then `rename` —
    /// identical shape to [`crate::search_index::SearchIndex::save`], for the
    /// identical reason: a crash must never leave a cursor advanced past an
    /// event this file does not also record as evaluated.
    pub fn save(&self) -> Result<(), CliError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::Other(format!("failed to create {}: {e}", parent.display()))
            })?;
        }
        let file = StateFile {
            version: STATE_VERSION,
            identity: self.identity.clone(),
            channels: self.cursors.clone(),
            evaluated: self.evaluated.clone(),
            scheduled: self.scheduled.clone(),
            reaction_cursors: self.reaction_cursors.clone(),
            reaction_targets: self.reaction_targets.clone(),
            admin_snapshots: self.admin_snapshots.clone(),
        };
        let json = serde_json::to_string(&file).map_err(|e| {
            CliError::Other(format!("failed to serialize the workflow agent state: {e}"))
        })?;

        let temp = self.path.with_extension("tmp");
        write_private(&temp, &json)?;
        std::fs::rename(&temp, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            CliError::Other(format!("failed to replace {}: {e}", self.path.display()))
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
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
        .map_err(|e| CliError::Other(format!("failed to write {}: {e}", path.display())))?;
    file.sync_all()
        .map_err(|e| CliError::Other(format!("failed to flush {}: {e}", path.display())))
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &str) -> Result<(), CliError> {
    std::fs::write(path, contents)
        .map_err(|e| CliError::Other(format!("failed to write {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(STATE_FILE);
        (dir, path)
    }

    #[test]
    fn a_missing_file_opens_as_empty_state() {
        let (_dir, path) = scratch();
        let state = WorkflowState::open(path);
        assert!(!state.is_evaluated("e1"));
        assert!(state.cursor("engineering").backfill_until().is_none());
    }

    #[test]
    fn evaluated_events_and_cursors_round_trip_through_one_atomic_save() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path.clone());
        state.mark_evaluated("e1");
        state.mark_evaluated("e2");
        let mut cursor = ChannelCursor::default();
        cursor.observe_newest(100, "e1");
        state.set_cursor("engineering", cursor.clone());
        state.assert_identity(&"AB".repeat(32)).unwrap();
        state.save().unwrap();

        let reopened = WorkflowState::open(path.clone());
        assert!(reopened.is_evaluated("e1"));
        assert!(reopened.is_evaluated("e2"));
        assert!(!reopened.is_evaluated("e3"));
        assert_eq!(reopened.cursor("engineering"), cursor);
        assert!(!path.with_extension("tmp").exists());
    }

    #[test]
    fn a_store_bound_to_another_identity_is_refused() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path.clone());
        state.assert_identity(&"11".repeat(32)).unwrap();
        state.save().unwrap();

        let mut reopened = WorkflowState::open(path);
        let err = reopened.assert_identity(&"22".repeat(32)).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
        assert!(reopened.assert_identity(&"11".repeat(32)).is_ok());
    }

    #[test]
    fn a_corrupt_or_future_state_file_rebuilds_instead_of_failing() {
        let (_dir, path) = scratch();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        std::fs::write(&path, "{ not json").unwrap();
        let state = WorkflowState::open(path.clone());
        assert!(!state.is_evaluated("e1"));

        std::fs::write(&path, r#"{"version": 99, "evaluated": ["e1"]}"#).unwrap();
        let state = WorkflowState::open(path);
        assert!(
            !state.is_evaluated("e1"),
            "a version this build cannot read is discarded whole"
        );
    }

    #[test]
    fn a_workflow_that_never_fired_has_no_last_fired_time() {
        let (_dir, path) = scratch();
        let state = WorkflowState::open(path);
        assert_eq!(state.last_fired("standup"), None);
    }

    #[test]
    fn last_fired_round_trips_through_one_atomic_save() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path.clone());
        state.set_last_fired("standup", 1_700_000_000);
        state.save().unwrap();

        let reopened = WorkflowState::open(path);
        assert_eq!(reopened.last_fired("standup"), Some(1_700_000_000));
        assert_eq!(reopened.last_fired("other"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_saved_state_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path.clone());
        state.mark_evaluated("e1");
        state.save().unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // ─── buzz#52: reaction cursor + target window ───────────────────────────

    #[test]
    fn a_channel_with_no_reaction_activity_has_an_empty_target_window() {
        let (_dir, path) = scratch();
        let state = WorkflowState::open(path);
        assert!(state.reaction_targets("engineering").is_empty());
        assert_eq!(
            state.reaction_cursor("engineering").tail_since(),
            ChannelCursor::default().tail_since()
        );
    }

    #[test]
    fn observed_reaction_targets_are_newest_first_and_deduplicated() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path);
        state.observe_reaction_target("eng", "e1", 10);
        state.observe_reaction_target("eng", "e2", 10);
        // Re-observing e1 (e.g. it still shows up in the next tail page)
        // must not duplicate it or leave it stuck at the back.
        state.observe_reaction_target("eng", "e1", 10);
        assert_eq!(state.reaction_targets("eng"), ["e1", "e2"]);
    }

    #[test]
    fn the_reaction_target_window_is_capped() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path);
        state.observe_reaction_target("eng", "e1", 2);
        state.observe_reaction_target("eng", "e2", 2);
        state.observe_reaction_target("eng", "e3", 2);
        assert_eq!(state.reaction_targets("eng"), ["e3", "e2"]);
    }

    #[test]
    fn reaction_cursor_and_targets_round_trip_through_one_atomic_save() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path.clone());
        let mut cursor = ChannelCursor::default();
        cursor.observe_newest(200, "r1");
        state.set_reaction_cursor("eng", cursor.clone());
        state.observe_reaction_target("eng", "m1", 10);
        state.save().unwrap();

        let reopened = WorkflowState::open(path);
        assert_eq!(reopened.reaction_cursor("eng"), cursor);
        assert_eq!(reopened.reaction_targets("eng"), ["m1"]);
    }

    // ─── buzz#52: admin_added snapshot ───────────────────────────────────────

    #[test]
    fn a_channel_never_observed_by_the_admin_pass_has_no_snapshot() {
        let (_dir, path) = scratch();
        let state = WorkflowState::open(path);
        assert_eq!(state.admin_snapshot("eng"), None);
    }

    #[test]
    fn admin_snapshot_round_trips_and_distinguishes_empty_from_absent() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path.clone());
        state.set_admin_snapshot("eng", BTreeSet::new());
        state.save().unwrap();

        let reopened = WorkflowState::open(path);
        assert_eq!(reopened.admin_snapshot("eng"), Some(&BTreeSet::new()));
        assert_eq!(reopened.admin_snapshot("never-seen"), None);
    }

    #[test]
    fn setting_an_admin_snapshot_replaces_the_previous_one() {
        let (_dir, path) = scratch();
        let mut state = WorkflowState::open(path);
        state.set_admin_snapshot("eng", BTreeSet::from(["a".to_string()]));
        state.set_admin_snapshot("eng", BTreeSet::from(["a".to_string(), "b".to_string()]));
        assert_eq!(
            state.admin_snapshot("eng"),
            Some(&BTreeSet::from(["a".to_string(), "b".to_string()]))
        );
    }
}
