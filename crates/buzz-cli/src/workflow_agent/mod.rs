//! `buzz toon workflow-agent` — a YAML-defined workflow reborn as a
//! subscribing agent-member (buzz#21, epic toon-meta#256 phase 5).
//!
//! `crates/buzz-workflow` is the server-side engine (buzz#20's sibling, not
//! its ancestor): multi-step, DB-backed, triggered by the relay itself. This
//! is the agent-member version buzz#19/#20 established the idiom for — a
//! long-running process that is a *member* of the channels it acts in, and
//! nothing more. One workflow (or a directory of them), one trigger type
//! (a message matching a condition), one action (a reply), evaluated only
//! against plaintext this identity was admitted to read, and posted back as a
//! paid write through the same sidecar that pays for `buzz toon send`.
//!
//! ## Membership by construction (identical to buzz#20)
//!
//! The ingest loop only ever walks [`crate::agent_keystore::AgentKeystore::channels`]
//! — the channels this identity holds a gift-wrapped key for. A workflow
//! scoped to a channel this agent was never admitted to simply never sees an
//! event to evaluate; there is no separate authorization check to get wrong,
//! because there is no code path that reaches a channel's plaintext without
//! going through the key ring first. See `crate::search_agent`'s module doc
//! for the fuller argument — it is unchanged here.
//!
//! One consequence worth stating plainly: a public (unkeyed) channel is never
//! walked at all, because `AgentKeystore::channels` only ever gains an entry
//! through a gift-wrapped grant (buzz#19's admission flow). A v1 workflow
//! can only trigger from a channel this agent was explicitly admitted to.
//!
//! ## Loop prevention
//!
//! Three mechanisms now (buzz#22 added the third), in the order
//! [`walk_channel`] checks them:
//!
//! 1. **[`is_own_event`] — the single-runner case.** An event authored by
//!    this identity is never evaluated, full stop, checked before a single
//!    byte of it is opened. A workflow whose reply text happens to match its
//!    own trigger (`contains: "hello"` replying `"hello back"`) therefore
//!    cannot loop: its own action event is the ineligible one, not the next
//!    incoming message.
//! 2. **[`is_workflow_action_event`] — the multi-runner case.** The
//!    `["client", "buzz-workflow"]` marker tag ([`CLIENT_MARKER`]) is carried
//!    on every action event via `send_message`'s `extra_tags` (the same
//!    idempotency-tag idiom desktop's write path uses,
//!    `desktop/src-tauri/src/events.rs`), and buzz#21 wrote it without ever
//!    reading it back — sufficient for one runner (rule 1 already closes
//!    that loop) but not for two: identity A's workflow replying to identity
//!    B's workflow's action, and vice versa, are each an ordinary *foreign*
//!    event to the other's `is_own_event` check. buzz#22 closes this by
//!    skipping *any* event carrying the marker, regardless of who signed it —
//!    the same "an action is never itself a trigger" invariant, extended from
//!    "by this identity" to "by any workflow runner". This is the direct
//!    analogue of upstream's `is_workflow_execution_kind` /
//!    `buzz:workflow`-tag check in `crates/buzz-relay/src/handlers/event.rs`
//!    — see `docs/workflow-agent-parity.md`.
//! 3. **A cross-triggering pair terminates in one hop either way.** With (2)
//!    in place, workflow A's action (tagged, from A) is never re-evaluated by
//!    B, and B's action is never re-evaluated by A — even when both are
//!    loaded into the *same* runner (rule 1 also applies there) or into two
//!    runners with different identities (rule 2 is what actually stops it).
//!    `tests/workflow_agent.rs`'s `a_cross_triggering_pair_of_workflows_terminates`
//!    and this module's `a_foreign_marked_event_never_fires` exercise the two
//!    halves.
//!
//! ## The walk: tail only, deliberately not backfill
//!
//! buzz#20's ingest loop pairs a forward *tail* walk with a backwards
//! *backfill* walk, because a search index benefits from both — recent
//! results immediately, the rest of history soon after. A workflow action is
//! a **paid write**, not a read, so backfilling history and firing on
//! whatever a channel's old messages happen to match would mean a first run
//! against a busy channel spends real money replaying its entire past. This
//! agent keeps only the tail: [`walk_channel`] is a direct port of
//! `crate::search_agent::walk_channel`'s forward half — the same
//! backwards-walk-floored-by-`since` shape, because a naive `since`-only poll
//! still loses the middle of a burst here exactly as it would for search —
//! with the evaluate-and-act step in place of indexing. `#22` (workflow
//! parity port) is where a bounded, explicitly-opted-into backfill would be
//! designed, if a use case needs it.
//!
//! ## Cursor semantics: at most once, not at least once
//!
//! [`store::WorkflowState`] persists, per channel, the same forward-tail
//! cursor `ChannelCursor` provides plus the set of event ids already run
//! through [`plan_trigger`] — necessary because NIP-01's inclusive `since`
//! re-delivers the cursor's boundary event every cycle (see the module docs
//! on both types). Committed atomically with the cursor after each cycle, so
//! a crash mid-cycle repeats work rather than skipping it, and a restart
//! never re-fires on an event this file already recorded as evaluated.
//!
//! A dropped action (sidecar unreachable through every retry) is **not**
//! queued for a later cycle: the triggering event is still marked evaluated,
//! and the reply is logged as dropped with its reason. Queuing would mean an
//! agent that fires ten actions while the sidecar is down still owes ten
//! stale replies whenever it comes back, at whatever cost that has drifted
//! to — a v1 semantics documented here on purpose, and one `#22` should
//! revisit if a use case needs guaranteed delivery.

mod schema;
mod store;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use buzz_channel_crypto::ChannelKey;
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};

pub use schema::Workflow;

use crate::agent_keystore::AgentKeystore;
use crate::channel_admins::tags_as_strings;
use crate::commands::toon::{open_message, send_message, sweep_inbox, Opened};
use crate::error::CliError;
use crate::search_agent::fetch_window;
use crate::sidecar::SidecarClient;

use store::WorkflowState;

/// The `["client", "buzz-workflow"]` tag every action event carries. See the
/// module doc's "Loop prevention" section for what this does and does not
/// buy.
pub const CLIENT_MARKER: &str = "buzz-workflow";

/// How many pages the tail walk will consume in one cycle before yielding.
/// Same rationale as `crate::search_agent::MAX_TAIL_PAGES`: without a cap, one
/// channel's burst could starve every other held channel's cycle.
const MAX_TAIL_PAGES: usize = 20;

/// Attempts (including the first) for one publish before the action is
/// dropped. See the module doc's "at most once, not at least once".
const PUBLISH_MAX_ATTEMPTS: u32 = 3;

/// Full-jitter backoff ceilings for attempts 1 and 2 (attempt 3 is never
/// retried further). Mirrors `client.rs`'s `RETRY_BASE_SECS` shape.
const PUBLISH_BACKOFF_SECS: [f64; 2] = [0.5, 2.0];

/// How many admin-list events one `admin_added` pass reads. Matches
/// `commands::toon`'s private `ADMIN_LIST_LIMIT`; the filter is not scoped by
/// channel, so one fetch answers for every held channel's diff (buzz#52).
const ADMIN_LIST_LIMIT: u32 = 500;

/// Where the workflow agent's collaborators live.
pub struct WorkflowAgentOptions<'a> {
    pub sidecar_url: &'a str,
    pub relay_url: &'a str,
    pub keystore_path: Option<&'a str>,
    pub state_path: Option<&'a str>,
    /// A single workflow YAML file, or a directory of them.
    pub workflows_path: &'a Path,
    pub poll_interval: Duration,
    pub page_size: u32,
    pub inbox_limit: u32,
    /// Run exactly one ingest cycle, print the report, and exit — what the
    /// tests drive, and the honest way to prove "restart resumes": two
    /// `--once` runs over the same state file.
    pub once: bool,
}

// ─── the trigger decision ────────────────────────────────────────────────────

/// Why a fetched event fired nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The agent holds no key for the channel. Checked before anything else
    /// that follows [`is_own_event`] — fail-closed, mirroring
    /// `crate::search_agent::SkipReason::NotAMember`. In practice this never
    /// fires from [`walk_channel`] (it only ever walks held channels); it
    /// exists for the same reason the search agent's does: a key can fall out
    /// of the ring between the inbox sweep and the walk.
    NotAMember,
    /// Sealed under an epoch (or a scheme) this ring cannot open.
    Locked,
    /// Opened, but there is no text to evaluate a trigger against.
    Empty,
    /// Opened and readable, but no workflow's condition matched.
    NoMatch,
    /// Carries the `["client", "buzz-workflow"]` marker tag — some workflow
    /// runner's own action, never a trigger. See the module doc's "Loop
    /// prevention" section, mechanism 2. Checked before decryption, like
    /// [`is_own_event`]: an action event is exactly as ineligible as one's
    /// own, whichever identity signed it.
    WorkflowAction,
    /// A kind:7 event with no `e` tag naming its target, or whose target
    /// falls outside the channel's recently-seen message window (buzz#52) —
    /// never fires a `reaction_added` trigger. The second case should never
    /// happen given the fetch's own `#e` filter; checked anyway because
    /// nothing here trusts the relay to have enforced it (ADR 0001).
    NoTarget,
}

impl SkipReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotAMember => "not-a-member",
            Self::Locked => "locked",
            Self::Empty => "empty",
            Self::NoMatch => "no-match",
            Self::WorkflowAction => "workflow-action",
            Self::NoTarget => "no-target",
        }
    }
}

/// What evaluating one already-opened, non-own event against a workflow set
/// decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggerOutcome {
    Skip(SkipReason),
    /// `workflow` names which one fired, for the cycle report and logs.
    Fire {
        workflow: String,
        /// What to do — a reply or a reaction on the triggering message
        /// (buzz#52).
        action: schema::ActionKind,
        /// `action.channel`, when the workflow overrides the default
        /// "reply into the channel the trigger fired in" destination
        /// (buzz#22). Always `None` for an `AddReaction` action (enforced at
        /// parse time — see [`schema::parse_workflow`]).
        channel_override: Option<String>,
    },
}

/// Is `event_pubkey` this runner's own identity?
///
/// The loop-prevention invariant with teeth (see the module doc): called
/// before a single byte of the event is opened, so an own event never even
/// reaches [`plan_trigger`]. Case-insensitive because hex pubkeys arrive from
/// more than one source (relay JSON, sidecar `/status`) and this must not be
/// the place a casing mismatch reopens the loop.
pub fn is_own_event(identity: &str, event_pubkey: &str) -> bool {
    identity.eq_ignore_ascii_case(event_pubkey)
}

/// Does `tags` carry the `["client", "buzz-workflow"]` marker
/// ([`CLIENT_MARKER`])? See the module doc's "Loop prevention" section,
/// mechanism 2 — this is what makes the marker `send_message`'s
/// `extra_tags` writes actually mean something, across runner identities and
/// not just within one.
///
/// Only the first two slots are checked (`["client", "buzz-workflow", ...]`
/// still matches) so a future third slot — e.g. naming which workflow acted —
/// does not require touching this check.
pub fn is_workflow_action_event(tags: &[Vec<String>]) -> bool {
    tags.iter().any(|tag| {
        tag.first().map(String::as_str) == Some("client")
            && tag.get(1).map(String::as_str) == Some(CLIENT_MARKER)
    })
}

/// Decide whether an already-opened, already-known-not-own,
/// already-known-not-a-workflow-action event fires a workflow.
///
/// Pure, like `crate::search_agent::plan_index` — the whole point is that
/// "membership is checked before readability, which is checked before
/// matching" is provable without a relay, a sidecar, or even a keystore in
/// the loop. Workflows are tried in file order (see
/// [`schema::load_workflows`]'s sort); the first whose channel scope and
/// condition both match wins, and later ones are not consulted. Schedule
/// workflows are never consulted here — [`Workflow::applies_to_channel`]
/// always returns `false` for them (see [`fire_schedules`] for their path).
pub fn plan_trigger(
    holds_key: bool,
    opened: &Opened,
    workflows: &[Workflow],
    channel_id: &str,
) -> TriggerOutcome {
    if !holds_key {
        return TriggerOutcome::Skip(SkipReason::NotAMember);
    }
    let text: &str = match opened {
        Opened::Locked { .. } => return TriggerOutcome::Skip(SkipReason::Locked),
        Opened::Plaintext(content) => content,
        Opened::Decrypted { content, .. } => content,
    };
    if text.trim().is_empty() {
        return TriggerOutcome::Skip(SkipReason::Empty);
    }
    for workflow in workflows {
        if !workflow.applies_to_channel(channel_id) {
            continue;
        }
        let Some(condition) = workflow.condition() else {
            continue;
        };
        if condition.evaluate(text) {
            return TriggerOutcome::Fire {
                workflow: workflow.name.clone(),
                action: workflow.action.clone(),
                channel_override: workflow.action_channel.clone(),
            };
        }
    }
    TriggerOutcome::Skip(SkipReason::NoMatch)
}

/// The `["e", target_event_id]` tag naming what a NIP-25 reaction is on. The
/// last matching tag wins, mirroring `crate::channel_admins::first_tag_value`'s
/// convention elsewhere in this codebase of taking one canonical reading of a
/// possibly-repeated tag; `buzz_sdk::builders::build_reaction` only ever
/// writes one, so this only matters for a reaction this agent did not itself
/// construct.
fn reaction_target(tags: &[Vec<String>]) -> Option<String> {
    tags.iter()
        .rev()
        .find(|tag| tag.first().map(String::as_str) == Some("e"))
        .and_then(|tag| tag.get(1).cloned())
}

/// Decide whether an already-known-not-own, already-known-not-a-workflow-
/// action, already-target-scoped kind:7 reaction fires a `reaction_added`
/// workflow (buzz#52). Pure, mirroring [`plan_trigger`]'s shape — the
/// membership/own-event/marker-tag checks all happen at the call site
/// (`reaction_pass`) before this is ever reached, the same division
/// `plan_trigger` and [`walk_channel`] keep.
///
/// Unlike `plan_trigger`, there is no `holds_key`/`Opened` check: a reaction
/// pass only ever runs against a channel already walked this cycle, which
/// only happens for a held channel — see `reaction_pass`'s call site in
/// [`cycle`].
pub fn plan_reaction_trigger(
    emoji: &str,
    workflows: &[Workflow],
    channel_id: &str,
) -> TriggerOutcome {
    for workflow in workflows {
        let Some(filter) = workflow.reaction_added() else {
            continue;
        };
        if workflow
            .channel
            .as_deref()
            .is_some_and(|only| only != channel_id)
        {
            continue;
        }
        if filter.is_some_and(|wanted| wanted != emoji) {
            continue;
        }
        return TriggerOutcome::Fire {
            workflow: workflow.name.clone(),
            action: workflow.action.clone(),
            channel_override: workflow.action_channel.clone(),
        };
    }
    TriggerOutcome::Skip(SkipReason::NoMatch)
}

/// Decide whether one newly-gained admin fires an `admin_added` workflow
/// scoped to `channel_id` (buzz#52). Pure, mirroring [`plan_reaction_trigger`]'s
/// shape — called once per newly-added admin by [`admin_added_pass`], which
/// owns the diff itself (there is no per-event "opened" step here: a
/// kind:39100 fold, not a single message or reaction, is what changed).
pub fn plan_admin_added_trigger(workflows: &[Workflow], channel_id: &str) -> TriggerOutcome {
    for workflow in workflows {
        if !workflow.is_admin_added() {
            continue;
        }
        if workflow
            .channel
            .as_deref()
            .is_some_and(|only| only != channel_id)
        {
            continue;
        }
        return TriggerOutcome::Fire {
            workflow: workflow.name.clone(),
            action: workflow.action.clone(),
            channel_override: workflow.action_channel.clone(),
        };
    }
    TriggerOutcome::Skip(SkipReason::NoMatch)
}

// ─── reports ─────────────────────────────────────────────────────────────────

/// What one channel's walk did, for the cycle report.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ChannelReport {
    pub seen: usize,
    pub fired: usize,
    pub sent: usize,
    pub dropped: usize,
    /// A fired action whose destination channel (`action.channel`, or a
    /// schedule's required destination) this identity holds no key for —
    /// refused before a publish was even attempted (buzz#22). See
    /// [`act`]'s doc.
    pub refused: usize,
    pub skipped: BTreeMap<&'static str, usize>,
}

impl ChannelReport {
    fn skip(&mut self, reason: SkipReason) {
        *self.skipped.entry(reason.code()).or_insert(0) += 1;
    }

    /// Fold another channel's activity into this one — used to combine the
    /// message walk's report with the same channel's reaction pass (buzz#52),
    /// since both act on the same channel within one cycle.
    fn merge(&mut self, other: ChannelReport) {
        self.seen += other.seen;
        self.fired += other.fired;
        self.sent += other.sent;
        self.dropped += other.dropped;
        self.refused += other.refused;
        for (code, count) in other.skipped {
            *self.skipped.entry(code).or_insert(0) += count;
        }
    }
}

/// What one cycle did across every held channel.
#[derive(Debug, Default)]
pub struct CycleReport {
    pub wraps_seen: usize,
    pub keys_accepted: usize,
    pub channels: BTreeMap<String, ChannelReport>,
    /// Per-channel transport failures. A relay hiccup on one channel must not
    /// abandon the others.
    pub errors: BTreeMap<String, String>,
}

impl CycleReport {
    pub fn fired(&self) -> usize {
        self.channels.values().map(|c| c.fired).sum()
    }

    pub fn sent(&self) -> usize {
        self.channels.values().map(|c| c.sent).sum()
    }

    pub fn dropped(&self) -> usize {
        self.channels.values().map(|c| c.dropped).sum()
    }

    pub fn refused(&self) -> usize {
        self.channels.values().map(|c| c.refused).sum()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "wrapsSeen": self.wraps_seen,
            "keysAccepted": self.keys_accepted,
            "fired": self.fired(),
            "sent": self.sent(),
            "dropped": self.dropped(),
            "refused": self.refused(),
            "channels": self.channels.iter().map(|(id, report)| json!({
                "channel": id,
                "seen": report.seen,
                "fired": report.fired,
                "sent": report.sent,
                "dropped": report.dropped,
                "refused": report.refused,
                "skipped": report.skipped,
            })).collect::<Vec<_>>(),
            "errors": self.errors.iter().map(|(id, error)| json!({
                "channel": id,
                "error": error,
            })).collect::<Vec<_>>(),
        })
    }
}

// ─── acting ──────────────────────────────────────────────────────────────────

/// The outcome of trying to publish one action.
enum ActionResult {
    Sent {
        event_id: String,
    },
    Dropped {
        reason: String,
    },
    /// The destination channel is one this identity holds no key for —
    /// refused before a publish was even attempted. See [`act`]'s doc.
    Refused {
        reason: String,
    },
}

/// `kind:7` — a NIP-25 reaction. Matches `buzz_sdk::builders::build_reaction`
/// (which this module does not call directly: that builder signs with a held
/// secret key, and the agent's identity is custodied by the sidecar — see the
/// module doc's "Who holds what" analogue in `commands::toon`). No `h` tag:
/// NIP-25 reactions are channel-scoped only by their `e`-tag target, which is
/// the whole gap `reaction_added`/`add_reaction` (buzz#52) work around.
const KIND_REACTION: u16 = 7;

/// What one fired action resolves to, once the triggering event is known.
/// [`schema::ActionKind::Reply`] carries everything it needs already;
/// [`schema::ActionKind::AddReaction`] additionally needs the id of the
/// message to react to, which only the call site (not the schema) has.
enum ActAttempt {
    Reply(String),
    AddReaction {
        target_event_id: String,
        emoji: String,
    },
}

/// Full-jitter delay for attempt `attempt` (0-indexed).
fn backoff_delay(attempt: u32) -> Duration {
    let ceiling = PUBLISH_BACKOFF_SECS[(attempt as usize).min(PUBLISH_BACKOFF_SECS.len() - 1)];
    Duration::from_secs_f64(ceiling * rand::random::<f64>())
}

/// Publish one workflow's action — a reply sealed through the same
/// [`send_message`] path `buzz toon send` uses, or a reaction on the
/// triggering message (buzz#52) — retrying a transient sidecar failure with
/// backoff before giving up loudly.
///
/// `target_channel` is the *destination* — the channel the trigger fired in
/// by default, or `action.channel`'s override / required schedule
/// destination (buzz#22; never set for an `AddReaction` attempt — see
/// [`schema::parse_workflow`]). Whichever it is, this identity must hold a
/// key for it: [`send_message`]'s own `plan_send` would happily post
/// plaintext into an unkeyed *public* channel with no key held at all, which
/// is the right call for a human typing `buzz toon send`, but not for an
/// unattended workflow action — a YAML file naming an arbitrary public
/// channel must not be enough, by itself, to make this identity post there on
/// a timer or on every matching message. Refusing (loud: logged, counted,
/// never silently dropped) is strictly narrower than what `send_message`
/// alone would allow, and that narrowing is deliberate. A reaction is
/// unsealed either way (NIP-25 has no encryption story — see
/// `commands::messages::add_reaction`'s desktop analogue), but the same
/// membership guard still applies: this identity must hold a key for
/// `target_channel` before it posts *anything*, sealed or not.
async fn act(
    client: &SidecarClient,
    relay_url: &str,
    keystore: &AgentKeystore,
    target_channel: &str,
    attempt: ActAttempt,
) -> ActionResult {
    if keystore.sending_key(target_channel).is_none() {
        return ActionResult::Refused {
            reason: format!(
                "this identity holds no channel key for {target_channel} — refusing to post \
there; an admin has to add this identity to that channel (the key arrives as a gift wrap), \
then `buzz toon inbox` before this action can succeed"
            ),
        };
    }

    let mut last_error = String::new();

    for attempt_n in 0..PUBLISH_MAX_ATTEMPTS {
        let outcome = match &attempt {
            ActAttempt::Reply(text) => {
                let extra_tags = vec![vec!["client".to_string(), CLIENT_MARKER.to_string()]];
                send_message(
                    client,
                    relay_url,
                    keystore,
                    target_channel,
                    text.clone(),
                    &extra_tags,
                )
                .await
                .map(|outcome| outcome.receipt.event_id)
            }
            ActAttempt::AddReaction {
                target_event_id,
                emoji,
            } => {
                let tags = vec![
                    vec!["e".to_string(), target_event_id.clone()],
                    vec!["client".to_string(), CLIENT_MARKER.to_string()],
                ];
                client
                    .publish_unsigned(KIND_REACTION, emoji.clone(), tags)
                    .await
                    .map(|receipt| receipt.event_id)
            }
        };
        match outcome {
            Ok(event_id) => return ActionResult::Sent { event_id },
            Err(e) => {
                let retryable = crate::error::is_retryable_error(&e);
                last_error = e.to_string();
                let attempts_left = attempt_n + 1 < PUBLISH_MAX_ATTEMPTS;
                if !retryable || !attempts_left {
                    break;
                }
                eprintln!(
                    "{}",
                    json!({
                        "event": "workflow-action-retry",
                        "channel": target_channel,
                        "attempt": attempt_n + 1,
                        "maxAttempts": PUBLISH_MAX_ATTEMPTS,
                        "error": last_error,
                    })
                );
                tokio::time::sleep(backoff_delay(attempt_n)).await;
            }
        }
    }
    ActionResult::Dropped { reason: last_error }
}

// ─── the ingest loop ─────────────────────────────────────────────────────────

/// Run the workflow agent: load definitions, then evaluate on a timer.
pub async fn run(opts: WorkflowAgentOptions<'_>) -> Result<(), CliError> {
    let client = SidecarClient::new(opts.sidecar_url.to_string())?;
    let identity = client.status().await?.identity.nostr_pubkey;

    let mut keystore = AgentKeystore::open(AgentKeystore::resolve_path(opts.keystore_path)?)?;
    keystore.assert_identity(&identity)?;

    let mut state = WorkflowState::open(WorkflowState::resolve_path(opts.state_path)?);
    state.assert_identity(&identity)?;

    // Loaded once at startup, not per cycle: a workflow file edited mid-run
    // takes effect on the next restart, exactly like the search agent's index
    // path or the keystore path — the daemon's inputs are fixed for its
    // lifetime, and "edit the YAML, restart the agent" is a fine v1 workflow
    // for what is still a single-operator demo surface.
    let workflows = schema::load_workflows(opts.workflows_path)?;

    println!(
        "{}",
        json!({
            "event": "workflow-agent-started",
            "identity": identity,
            "workflows": workflows.iter().map(|w| json!({
                "name": w.name,
                "source": w.source.display().to_string(),
                "channel": w.channel,
                "schedule": w.schedule().map(|s| s.source.clone()),
                "actionChannel": w.action_channel,
            })).collect::<Vec<_>>(),
            "state": state.path().display().to_string(),
            "keystore": keystore.path().display().to_string(),
            "relay": opts.relay_url,
        })
    );

    // Fixed for the process's lifetime — the anchor a never-yet-fired
    // schedule is measured from (see `is_schedule_due`'s doc: "no
    // retroactive fire" means "not due until the first tick after *this*
    // moment", not after some arbitrary historical instant a restart would
    // otherwise have to persist to keep meaning the same thing).
    let started_at = Utc::now();

    loop {
        let report = cycle(
            &client,
            &opts,
            &identity,
            &mut keystore,
            &mut state,
            &workflows,
            started_at,
        )
        .await?;
        println!(
            "{}",
            json!({
                "event": "workflow-agent-cycle",
                "report": report.to_json(),
            })
        );
        if opts.once {
            return Ok(());
        }
        tokio::time::sleep(opts.poll_interval).await;
    }
}

/// One ingest cycle: collect keys, then walk every channel the agent holds
/// one for, then commit the evaluated set and cursors together.
async fn cycle(
    client: &SidecarClient,
    opts: &WorkflowAgentOptions<'_>,
    identity: &str,
    keystore: &mut AgentKeystore,
    state: &mut WorkflowState,
    workflows: &[Workflow],
    started_at: chrono::DateTime<Utc>,
) -> Result<CycleReport, CliError> {
    let mut report = CycleReport::default();

    // 1. Admission, via the identical fold `buzz toon inbox` and the search
    //    agent run. New keys are what make a channel appear in the walk below
    //    for the first time.
    let sweep = sweep_inbox(client, opts.relay_url, identity, keystore, opts.inbox_limit).await?;
    report.wraps_seen = sweep.wraps_seen;
    report.keys_accepted = sweep.accepted.len();
    keystore.save()?;

    // Nothing below mutates the keystore again this cycle — reborrow it
    // immutably so it can be shared with `walk_channel`/`act` (which post
    // through it) without a second `&mut` in scope.
    let keystore: &AgentKeystore = keystore;

    // 2. Walk each held channel's tail and act on what fires, then run that
    //    same channel's reaction pass (buzz#52) — a second fetch scoped to
    //    the message ids the walk above just observed (see `reaction_pass`'s
    //    doc), folded into the same per-channel report.
    let channels: Vec<String> = keystore.channels().cloned().collect();
    for channel_id in channels.iter().cloned() {
        let ring = keystore.ring(&channel_id).to_vec();
        let mut channel_report = match walk_channel(
            opts,
            client,
            identity,
            keystore,
            &channel_id,
            &ring,
            workflows,
            state,
        )
        .await
        {
            Ok(channel_report) => channel_report,
            Err(error) => {
                report.errors.insert(channel_id, error.to_string());
                continue;
            }
        };

        match reaction_pass(
            opts,
            client,
            identity,
            keystore,
            &channel_id,
            workflows,
            state,
        )
        .await
        {
            Ok(reaction_report) => channel_report.merge(reaction_report),
            Err(error) => {
                report.errors.insert(channel_id.clone(), error.to_string());
            }
        }
        report.channels.insert(channel_id, channel_report);
    }

    // 3. Fire any `schedule:` workflows that are due (buzz#22) — a separate
    //    pass, not part of the channel walk above, because a schedule has no
    //    triggering channel or event; see the module doc.
    for (channel_id, sched_report) in fire_schedules(
        client,
        opts.relay_url,
        keystore,
        workflows,
        state,
        started_at,
        Utc::now(),
    )
    .await
    {
        let entry = report.channels.entry(channel_id).or_default();
        entry.fired += sched_report.fired;
        entry.sent += sched_report.sent;
        entry.dropped += sched_report.dropped;
        entry.refused += sched_report.refused;
    }

    // 4. Diff each held channel's admin-list fold against last cycle's
    //    snapshot and fire any `admin_added` workflow for a newly-gained
    //    admin (buzz#52) — a third pass, like the schedule pass not driven
    //    by the channel walk (there is no triggering message or reaction,
    //    only a list event); see `admin_added_pass`'s doc for why it is one
    //    fetch for the whole cycle rather than one per channel.
    for (channel_id, admin_report) in admin_added_pass(
        client,
        opts.relay_url,
        keystore,
        &channels,
        workflows,
        state,
    )
    .await
    {
        report
            .channels
            .entry(channel_id)
            .or_default()
            .merge(admin_report);
    }

    // 5. One atomic commit for the whole cycle: the evaluated set, every
    //    cursor, and every schedule's/admin-list's last-observed state land
    //    together or not at all.
    state.save()?;
    Ok(report)
}

/// Check every `schedule:` workflow against the wall clock, act on the ones
/// that are due, and record their fire time — the schedule analogue of
/// [`walk_channel`]'s "evaluate, act, persist" shape, minus a channel walk to
/// drive it (see the module doc's "buzz#22" section).
///
/// Returns one [`ChannelReport`] per destination channel a schedule fired
/// into, for the caller to fold into [`CycleReport::channels`].
async fn fire_schedules(
    client: &SidecarClient,
    relay_url: &str,
    keystore: &AgentKeystore,
    workflows: &[Workflow],
    state: &mut WorkflowState,
    started_at: chrono::DateTime<Utc>,
    now: chrono::DateTime<Utc>,
) -> BTreeMap<String, ChannelReport> {
    let mut reports: BTreeMap<String, ChannelReport> = BTreeMap::new();
    // `timestamp()` is negative only before 1970 — clamped rather than
    // `as u64`-wrapped, so a clock that is merely wrong reads as "never due"
    // instead of "due since a huge unsigned time in the future".
    let now_secs = now.timestamp().max(0) as u64;
    let started_at_secs = started_at.timestamp().max(0) as u64;

    for workflow in workflows {
        let Some(schedule) = workflow.schedule() else {
            continue;
        };
        // A schedule that has never fired (by this state file) is measured
        // from the process's start time, not from `now` at each individual
        // check — anchoring to "now" would mean every check re-bases its own
        // reference point to itself, and a strictly-after comparison against
        // its own instant is never due, ever, no matter how much wall-clock
        // time actually passes. See `is_schedule_due`'s doc.
        let since = state.last_fired(&workflow.name).unwrap_or(started_at_secs);
        if !is_schedule_due(&schedule.compiled, since, now_secs) {
            continue;
        }
        // `schema::parse_workflow` requires `action.channel` for every
        // schedule trigger — there is no triggering channel to fall back to.
        let target_channel = workflow
            .action_channel
            .as_deref()
            .expect("a schedule workflow always has action_channel — enforced at parse time");
        // `schema::parse_workflow` also rejects `add_reaction` on a schedule
        // trigger — there is no triggering message to react to.
        let reply_text = match &workflow.action {
            schema::ActionKind::Reply(text) => text.clone(),
            schema::ActionKind::AddReaction { .. } => {
                unreachable!(
                    "a schedule workflow's action is always Reply — enforced at parse time"
                )
            }
        };

        let report = reports.entry(target_channel.to_string()).or_default();
        report.fired += 1;
        match act(
            client,
            relay_url,
            keystore,
            target_channel,
            ActAttempt::Reply(reply_text),
        )
        .await
        {
            ActionResult::Sent { event_id } => {
                report.sent += 1;
                println!(
                    "{}",
                    json!({
                        "event": "workflow-action-sent",
                        "workflow": workflow.name,
                        "trigger": "schedule",
                        "channel": target_channel,
                        "targetChannel": target_channel,
                        "actionEvent": event_id,
                    })
                );
            }
            ActionResult::Dropped { reason } => {
                report.dropped += 1;
                eprintln!(
                    "{}",
                    json!({
                        "event": "workflow-action-dropped",
                        "workflow": workflow.name,
                        "trigger": "schedule",
                        "channel": target_channel,
                        "targetChannel": target_channel,
                        "reason": reason,
                    })
                );
            }
            ActionResult::Refused { reason } => {
                report.refused += 1;
                eprintln!(
                    "{}",
                    json!({
                        "event": "workflow-action-refused",
                        "workflow": workflow.name,
                        "trigger": "schedule",
                        "channel": target_channel,
                        "targetChannel": target_channel,
                        "reason": reason,
                    })
                );
            }
        }
        // Recorded regardless of Sent/Dropped/Refused — this slot is used up
        // either way, mirroring `mark_evaluated`'s "not queued for a later
        // cycle" rule (see the module doc).
        state.set_last_fired(&workflow.name, now_secs);
    }
    reports
}

/// Is `schedule` due to fire, given `since` (unix seconds — the last time it
/// fired, or, if it never has, a fixed reference point the caller chooses —
/// see [`fire_schedules`]) and the current wall-clock time `now` (also unix
/// seconds)?
///
/// Due exactly when the schedule's next tick *strictly after* `since` has
/// already passed relative to `now`. This is what makes a missed tick (the
/// agent was down, or one slow cycle) still fire exactly once when the agent
/// next checks, without replaying every tick that would have fired in
/// between — there is only ever "the next one", never "the backlog".
///
/// `since` deliberately is **not** "now at this call" for the
/// never-fired case — that would make firing impossible: a schedule strictly
/// after its own instant is never due *at* that instant, and if every
/// subsequent check re-anchors to its own new "now", it stays permanently
/// one tick away from due, forever. The anchor has to be a fixed point that
/// does not move just because the check ran again — [`fire_schedules`]
/// supplies the process's start time for that case, chosen once and reused
/// across every cycle until the schedule fires for the first time.
///
/// Pure and independent of wall-clock reality, which is what makes cron
/// testable without waiting on it: every case in this module's tests drives
/// `since` and `now` directly.
pub fn is_schedule_due(schedule: &cron::Schedule, since: u64, now: u64) -> bool {
    let Some(now_dt) = Utc.timestamp_opt(now as i64, 0).single() else {
        return false;
    };
    let Some(since_dt) = Utc.timestamp_opt(since as i64, 0).single() else {
        return false;
    };
    schedule
        .after(&since_dt)
        .next()
        .is_some_and(|next| next <= now_dt)
}

/// The tail walk for one channel: fetch, evaluate, act, and (only once the
/// walk is exhausted) advance the cursor. See the module doc for why there is
/// no backfill half.
#[allow(clippy::too_many_arguments)]
async fn walk_channel(
    opts: &WorkflowAgentOptions<'_>,
    client: &SidecarClient,
    identity: &str,
    keystore: &AgentKeystore,
    channel_id: &str,
    ring: &[ChannelKey],
    workflows: &[Workflow],
    state: &mut WorkflowState,
) -> Result<ChannelReport, CliError> {
    let mut report = ChannelReport::default();
    let mut cursor = state.cursor(channel_id);
    let page = opts.page_size.max(1);

    // With no tail cursor yet there is nothing to be lossless *about*: the
    // head page contains the newest event by definition, so one page and
    // done is correct for a first run — see
    // `crate::search_agent::walk_channel`'s identical comment.
    let since = cursor.tail_since();
    let max_pages = if since.is_some() { MAX_TAIL_PAGES } else { 1 };
    let mut until: Option<u64> = None;
    let mut newest: Option<(u64, String)> = None;
    let mut exhausted = since.is_none();

    for _ in 0..max_pages {
        let events = fetch_window(opts.relay_url, channel_id, since, until, page).await?;
        let full = events.len() >= page as usize;
        let boundary = events.last().map(|e| e.created_at.as_secs());

        for event in &events {
            report.seen += 1;
            let created_at = event.created_at.as_secs();
            let event_id = event.id.to_hex();
            if newest
                .as_ref()
                .is_none_or(|(at, id)| created_at > *at || (created_at == *at && event_id < *id))
            {
                newest = Some((created_at, event_id.clone()));
            }

            // Every message seen — own, locked, already evaluated, whatever
            // — is fair game for a later reaction, so the reaction pass's
            // scoping window (buzz#52) is updated unconditionally, ahead of
            // every early-continue below.
            state.observe_reaction_target(channel_id, &event_id, page as usize);

            // The tail re-walks from the head every cycle (NIP-01 `since` is
            // inclusive), so most of what it sees was already evaluated. This
            // is the check that stops the boundary event from re-firing on
            // every cycle forever — see the module doc's cursor-semantics
            // section.
            if state.is_evaluated(&event_id) {
                continue;
            }

            let event_pubkey = event.pubkey.to_hex();
            if is_own_event(identity, &event_pubkey) {
                state.mark_evaluated(&event_id);
                continue;
            }

            let tags = tags_as_strings(event);
            if is_workflow_action_event(&tags) {
                report.skip(SkipReason::WorkflowAction);
                state.mark_evaluated(&event_id);
                continue;
            }

            let opened = open_message(&tags, &event.content, ring);
            let outcome = plan_trigger(!ring.is_empty(), &opened, workflows, channel_id);
            match outcome {
                TriggerOutcome::Skip(reason) => report.skip(reason),
                TriggerOutcome::Fire {
                    workflow,
                    action,
                    channel_override,
                } => {
                    report.fired += 1;
                    let target_channel = channel_override.as_deref().unwrap_or(channel_id);
                    let attempt = match action {
                        schema::ActionKind::Reply(text) => ActAttempt::Reply(text),
                        schema::ActionKind::AddReaction { emoji } => ActAttempt::AddReaction {
                            target_event_id: event_id.clone(),
                            emoji,
                        },
                    };
                    match act(client, opts.relay_url, keystore, target_channel, attempt).await {
                        ActionResult::Sent {
                            event_id: action_id,
                        } => {
                            report.sent += 1;
                            println!(
                                "{}",
                                json!({
                                    "event": "workflow-action-sent",
                                    "workflow": workflow,
                                    "channel": channel_id,
                                    "targetChannel": target_channel,
                                    "triggerEvent": event_id,
                                    "actionEvent": action_id,
                                })
                            );
                        }
                        ActionResult::Dropped { reason } => {
                            report.dropped += 1;
                            eprintln!(
                                "{}",
                                json!({
                                    "event": "workflow-action-dropped",
                                    "workflow": workflow,
                                    "channel": channel_id,
                                    "targetChannel": target_channel,
                                    "triggerEvent": event_id,
                                    "reason": reason,
                                })
                            );
                        }
                        ActionResult::Refused { reason } => {
                            report.refused += 1;
                            eprintln!(
                                "{}",
                                json!({
                                    "event": "workflow-action-refused",
                                    "workflow": workflow,
                                    "channel": channel_id,
                                    "targetChannel": target_channel,
                                    "triggerEvent": event_id,
                                    "reason": reason,
                                })
                            );
                        }
                    }
                }
            }
            state.mark_evaluated(&event_id);
        }

        match (full, boundary) {
            (true, Some(oldest)) if since.is_some_and(|floor| oldest > floor) => {
                until = Some(oldest)
            }
            _ => {
                exhausted = true;
                break;
            }
        }
    }

    // Only a completed walk may advance the cursor: advancing after a capped
    // walk would strand every event between the cap and the head unevaluated
    // for a full extra `MAX_TAIL_PAGES` next time.
    if exhausted {
        if let Some((created_at, event_id)) = newest {
            cursor.observe_newest(created_at, &event_id);
        }
    }
    state.set_cursor(channel_id, cursor);

    Ok(report)
}

/// One page of kind:7 reactions targeting `target_ids`, newest first — the
/// reaction-fetch analogue of [`fetch_window`], reusing
/// `crate::search_agent::relay_order`'s dedupe/sort for the same reason that
/// module does: never assume the relay itself sorted or deduped.
async fn fetch_reactions(
    relay_url: &str,
    target_ids: &[String],
    since: Option<u64>,
    limit: u32,
) -> Result<Vec<nostr::Event>, CliError> {
    let filter = crate::toon_relay::reaction_filter(target_ids, limit, since);
    Ok(crate::search_agent::relay_order(
        crate::toon_relay::fetch(relay_url, filter).await?,
    ))
}

/// The `reaction_added` trigger's own pass for one channel (buzz#52): one
/// extra relay round trip per cycle, scoped by `#e` to the message ids
/// [`walk_channel`] has recently observed in this same channel (see
/// `docs/workflow-agent-parity.md`'s `reaction_added` row for why a reaction
/// fetch cannot simply scope by channel the way the message walk does).
///
/// Deliberately a single fetch, not a paged walk like [`walk_channel`]: the
/// `#e` scope is already bounded to at most a page's worth of target ids, so
/// there is no unbounded backlog to page through the way a channel's message
/// history can have.
///
/// Shares [`walk_channel`]'s ordering of checks — evaluated, then own-event,
/// then workflow-action-marker, then (here, in place of decrypt) target
/// scoping — before [`plan_reaction_trigger`] is ever consulted.
#[allow(clippy::too_many_arguments)]
async fn reaction_pass(
    opts: &WorkflowAgentOptions<'_>,
    client: &SidecarClient,
    identity: &str,
    keystore: &AgentKeystore,
    channel_id: &str,
    workflows: &[Workflow],
    state: &mut WorkflowState,
) -> Result<ChannelReport, CliError> {
    let mut report = ChannelReport::default();
    let targets = state.reaction_targets(channel_id).to_vec();
    if targets.is_empty() {
        return Ok(report);
    }

    let mut cursor = state.reaction_cursor(channel_id);
    let since = cursor.tail_since();
    let events = fetch_reactions(opts.relay_url, &targets, since, opts.page_size.max(1)).await?;

    let mut newest: Option<(u64, String)> = None;
    for event in &events {
        report.seen += 1;
        let created_at = event.created_at.as_secs();
        let event_id = event.id.to_hex();
        if newest
            .as_ref()
            .is_none_or(|(at, id)| created_at > *at || (created_at == *at && event_id < *id))
        {
            newest = Some((created_at, event_id.clone()));
        }

        if state.is_evaluated(&event_id) {
            continue;
        }

        let event_pubkey = event.pubkey.to_hex();
        if is_own_event(identity, &event_pubkey) {
            state.mark_evaluated(&event_id);
            continue;
        }

        let tags = tags_as_strings(event);
        if is_workflow_action_event(&tags) {
            report.skip(SkipReason::WorkflowAction);
            state.mark_evaluated(&event_id);
            continue;
        }

        let target = reaction_target(&tags).filter(|target| targets.contains(target));
        let Some(target_event_id) = target else {
            report.skip(SkipReason::NoTarget);
            state.mark_evaluated(&event_id);
            continue;
        };

        let outcome = plan_reaction_trigger(&event.content, workflows, channel_id);
        match outcome {
            TriggerOutcome::Skip(reason) => report.skip(reason),
            TriggerOutcome::Fire {
                workflow,
                action,
                channel_override,
            } => {
                report.fired += 1;
                let target_channel = channel_override.as_deref().unwrap_or(channel_id);
                let attempt = match action {
                    schema::ActionKind::Reply(text) => ActAttempt::Reply(text),
                    schema::ActionKind::AddReaction { emoji } => ActAttempt::AddReaction {
                        target_event_id: target_event_id.clone(),
                        emoji,
                    },
                };
                match act(client, opts.relay_url, keystore, target_channel, attempt).await {
                    ActionResult::Sent {
                        event_id: action_id,
                    } => {
                        report.sent += 1;
                        println!(
                            "{}",
                            json!({
                                "event": "workflow-action-sent",
                                "workflow": workflow,
                                "trigger": "reaction_added",
                                "channel": channel_id,
                                "targetChannel": target_channel,
                                "triggerEvent": event_id,
                                "reactionTarget": target_event_id,
                                "actionEvent": action_id,
                            })
                        );
                    }
                    ActionResult::Dropped { reason } => {
                        report.dropped += 1;
                        eprintln!(
                            "{}",
                            json!({
                                "event": "workflow-action-dropped",
                                "workflow": workflow,
                                "trigger": "reaction_added",
                                "channel": channel_id,
                                "targetChannel": target_channel,
                                "triggerEvent": event_id,
                                "reactionTarget": target_event_id,
                                "reason": reason,
                            })
                        );
                    }
                    ActionResult::Refused { reason } => {
                        report.refused += 1;
                        eprintln!(
                            "{}",
                            json!({
                                "event": "workflow-action-refused",
                                "workflow": workflow,
                                "trigger": "reaction_added",
                                "channel": channel_id,
                                "targetChannel": target_channel,
                                "triggerEvent": event_id,
                                "reactionTarget": target_event_id,
                                "reason": reason,
                            })
                        );
                    }
                }
            }
        }
        state.mark_evaluated(&event_id);
    }

    if let Some((created_at, event_id)) = newest {
        cursor.observe_newest(created_at, &event_id);
    }
    state.set_reaction_cursor(channel_id, cursor);

    Ok(report)
}

/// The `admin_added` trigger's own pass, for every held channel in one cycle
/// (buzz#52): fold each channel's kind:39100 admin list, diff it against the
/// previous cycle's snapshot, and fire for each admin the fold gained.
///
/// One relay fetch for the whole cycle, not one per channel:
/// `channel_admins::channel_admin_list_filter` already reads every admin-list
/// event on the relay regardless of channel (the same shape
/// `commands::toon::fetch_admin_events` uses, for the same reason — an agent
/// must be able to validate a key, or here a diff, without a second
/// channel-scoped round trip), so every held channel's diff reads from the
/// one page fetched here.
///
/// Skips the fetch entirely when no loaded workflow is `admin_added`-scoped
/// — the same "no surface not in active use" restraint `schema`'s module doc
/// states for the agent-member idiom generally.
///
/// A channel observed for the first time seeds its snapshot without firing:
/// there is no genuine "just joined" to report for admins that were already
/// there when this agent started watching (see [`WorkflowState::admin_snapshot`]'s
/// doc). A transport failure on the fetch is not fatal to the cycle — the
/// diff is simply skipped and retried next cycle, the same tolerance
/// `reaction_pass`'s and `walk_channel`'s own relay reads do not have (they
/// propagate `?`) because unlike them this pass has no single channel's error
/// to attribute a failure to.
async fn admin_added_pass(
    client: &SidecarClient,
    relay_url: &str,
    keystore: &AgentKeystore,
    channels: &[String],
    workflows: &[Workflow],
    state: &mut WorkflowState,
) -> BTreeMap<String, ChannelReport> {
    let mut reports: BTreeMap<String, ChannelReport> = BTreeMap::new();
    if !workflows.iter().any(Workflow::is_admin_added) {
        return reports;
    }

    let events = match crate::toon_relay::fetch(
        relay_url,
        crate::channel_admins::channel_admin_list_filter(ADMIN_LIST_LIMIT),
    )
    .await
    {
        Ok(events) => events,
        Err(_) => return reports,
    };

    for channel_id in channels {
        let resolved = crate::channel_admins::resolve_channel_admin_list(
            &events,
            channel_id,
            keystore.pinned_creator(channel_id),
        );
        let current: BTreeSet<String> = resolved
            .map(|list| list.admins.into_iter().collect())
            .unwrap_or_default();

        let newly_added: Vec<String> = match state.admin_snapshot(channel_id) {
            None => {
                state.set_admin_snapshot(channel_id, current);
                continue;
            }
            Some(previous) => current.difference(previous).cloned().collect(),
        };
        if newly_added.is_empty() {
            state.set_admin_snapshot(channel_id, current);
            continue;
        }

        let mut report = ChannelReport::default();
        for admin in &newly_added {
            match plan_admin_added_trigger(workflows, channel_id) {
                TriggerOutcome::Skip(reason) => report.skip(reason),
                TriggerOutcome::Fire {
                    workflow,
                    action,
                    channel_override,
                } => {
                    report.fired += 1;
                    let target_channel = channel_override.as_deref().unwrap_or(channel_id);
                    let attempt = match action {
                        schema::ActionKind::Reply(text) => ActAttempt::Reply(text),
                        schema::ActionKind::AddReaction { .. } => unreachable!(
                            "admin_added cannot use add_reaction — enforced at parse time"
                        ),
                    };
                    match act(client, relay_url, keystore, target_channel, attempt).await {
                        ActionResult::Sent {
                            event_id: action_id,
                        } => {
                            report.sent += 1;
                            println!(
                                "{}",
                                json!({
                                    "event": "workflow-action-sent",
                                    "workflow": workflow,
                                    "trigger": "admin_added",
                                    "channel": channel_id,
                                    "targetChannel": target_channel,
                                    "newAdmin": admin,
                                    "actionEvent": action_id,
                                })
                            );
                        }
                        ActionResult::Dropped { reason } => {
                            report.dropped += 1;
                            eprintln!(
                                "{}",
                                json!({
                                    "event": "workflow-action-dropped",
                                    "workflow": workflow,
                                    "trigger": "admin_added",
                                    "channel": channel_id,
                                    "targetChannel": target_channel,
                                    "newAdmin": admin,
                                    "reason": reason,
                                })
                            );
                        }
                        ActionResult::Refused { reason } => {
                            report.refused += 1;
                            eprintln!(
                                "{}",
                                json!({
                                    "event": "workflow-action-refused",
                                    "workflow": workflow,
                                    "trigger": "admin_added",
                                    "channel": channel_id,
                                    "targetChannel": target_channel,
                                    "newAdmin": admin,
                                    "reason": reason,
                                })
                            );
                        }
                    }
                }
            }
        }
        state.set_admin_snapshot(channel_id, current);
        reports.insert(channel_id.clone(), report);
    }
    reports
}

#[cfg(test)]
mod tests {
    use buzz_channel_crypto::{channel_key_id, encryption_tag, seal, ChannelKey};

    use super::*;

    const KEY: ChannelKey = [0xdd; 32];

    fn workflow(yaml: &str) -> Workflow {
        schema::parse_workflow(yaml, Path::new("test.yaml")).unwrap()
    }

    #[test]
    fn own_events_are_identified_case_insensitively() {
        let id = "ab".repeat(32);
        assert!(is_own_event(&id, &id.to_uppercase()));
        assert!(is_own_event(&id.to_uppercase(), &id));
        assert!(!is_own_event(&id, &"cd".repeat(32)));
    }

    #[test]
    fn a_channel_with_no_held_key_never_fires() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: hello\naction:\n  reply: hi\n",
        )];
        let outcome = plan_trigger(
            false,
            &Opened::Plaintext("hello there".into()),
            &workflows,
            "engineering",
        );
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NotAMember));
    }

    #[test]
    fn locked_content_never_fires() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: hello\naction:\n  reply: hi\n",
        )];
        let outcome = plan_trigger(
            true,
            &Opened::Locked {
                key_id: Some(channel_key_id(&KEY)),
            },
            &workflows,
            "engineering",
        );
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::Locked));
    }

    #[test]
    fn a_blank_message_never_fires() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: hello\naction:\n  reply: hi\n",
        )];
        let outcome = plan_trigger(true, &Opened::Plaintext("   ".into()), &workflows, "eng");
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::Empty));
    }

    #[test]
    fn a_matching_message_fires_the_named_workflow() {
        let workflows = vec![workflow(
            "version: 1\nname: greeter\ntrigger:\n  contains: hello\naction:\n  reply: hi there\n",
        )];
        let outcome = plan_trigger(
            true,
            &Opened::Plaintext("hello team".into()),
            &workflows,
            "eng",
        );
        assert_eq!(
            outcome,
            TriggerOutcome::Fire {
                workflow: "greeter".to_string(),
                action: schema::ActionKind::Reply("hi there".to_string()),
                channel_override: None,
            }
        );
    }

    #[test]
    fn a_non_matching_message_is_a_no_match_not_an_error() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: hello\naction:\n  reply: hi\n",
        )];
        let outcome = plan_trigger(
            true,
            &Opened::Plaintext("good morning".into()),
            &workflows,
            "eng",
        );
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NoMatch));
    }

    #[test]
    fn a_workflow_scoped_to_another_channel_is_not_consulted() {
        let workflows = vec![workflow(concat!(
            "version: 1\n",
            "trigger:\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n  contains: hello\n",
            "action:\n  reply: hi\n",
        ))];
        let outcome = plan_trigger(
            true,
            &Opened::Plaintext("hello".into()),
            &workflows,
            "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a",
        );
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NoMatch));
    }

    /// The property the acceptance criteria calls out by name: a workflow
    /// whose reply matches its own trigger does not loop, because the reply
    /// is filtered out by [`is_own_event`] long before `plan_trigger` runs —
    /// this test asserts the piece of the invariant that lives at this layer:
    /// firing is a pure function of content, so nothing here treats the
    /// runner's own past replies specially. The identity filter is what
    /// carries the rest, and is exercised end-to-end in
    /// `tests/workflow_agent.rs`.
    #[test]
    fn a_self_matching_reply_would_fire_again_on_content_alone() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: hello\naction:\n  reply: hello back\n",
        )];
        let outcome = plan_trigger(
            true,
            &Opened::Plaintext("hello back".into()),
            &workflows,
            "eng",
        );
        assert!(
            matches!(outcome, TriggerOutcome::Fire { .. }),
            "content-based matching alone cannot distinguish a reply from a trigger — \
this is exactly why is_own_event must run first, unconditionally"
        );
    }

    #[test]
    fn sealed_content_is_opened_before_the_trigger_is_evaluated() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: hello\naction:\n  reply: hi\n",
        )];
        let sealed = seal("hello team", &KEY);
        let tags = vec![
            vec!["h".to_string(), "eng".to_string()],
            encryption_tag(&KEY).to_vec(),
        ];
        let opened = open_message(&tags, &sealed, &[KEY]);
        let outcome = plan_trigger(true, &opened, &workflows, "eng");
        assert!(matches!(outcome, TriggerOutcome::Fire { .. }));
    }

    #[test]
    fn skip_reason_codes_are_stable_and_distinct() {
        let all = [
            SkipReason::NotAMember,
            SkipReason::Locked,
            SkipReason::Empty,
            SkipReason::NoMatch,
            SkipReason::WorkflowAction,
            SkipReason::NoTarget,
        ];
        let mut codes: Vec<&str> = all.iter().map(|r| r.code()).collect();
        codes.sort_unstable();
        let count = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), count);
    }

    #[test]
    fn cycle_report_json_sums_channels() {
        let mut report = CycleReport::default();
        let a = ChannelReport {
            fired: 2,
            sent: 1,
            dropped: 1,
            ..Default::default()
        };
        report.channels.insert("a".to_string(), a);
        let b = ChannelReport {
            fired: 1,
            sent: 1,
            ..Default::default()
        };
        report.channels.insert("b".to_string(), b);

        assert_eq!(report.fired(), 3);
        assert_eq!(report.sent(), 2);
        assert_eq!(report.dropped(), 1);
        let json = report.to_json();
        assert_eq!(json["fired"], 3);
        assert_eq!(json["sent"], 2);
        assert_eq!(json["dropped"], 1);
    }

    #[test]
    fn cycle_report_json_sums_refused() {
        let mut report = CycleReport::default();
        report.channels.insert(
            "a".to_string(),
            ChannelReport {
                refused: 2,
                ..Default::default()
            },
        );
        report.channels.insert(
            "b".to_string(),
            ChannelReport {
                refused: 1,
                ..Default::default()
            },
        );
        assert_eq!(report.refused(), 3);
        assert_eq!(report.to_json()["refused"], 3);
    }

    // ─── buzz#22: the multi-runner leg of loop prevention ───────────────────

    #[test]
    fn a_workflow_action_event_is_recognised_by_its_marker_tag() {
        let tags = vec![
            vec!["h".to_string(), "eng".to_string()],
            vec!["client".to_string(), CLIENT_MARKER.to_string()],
        ];
        assert!(is_workflow_action_event(&tags));
    }

    #[test]
    fn an_ordinary_message_is_not_a_workflow_action_event() {
        let tags = vec![vec!["h".to_string(), "eng".to_string()]];
        assert!(!is_workflow_action_event(&tags));
    }

    #[test]
    fn a_different_client_tag_is_not_a_workflow_action_event() {
        let tags = vec![vec!["client".to_string(), "some-other-client".to_string()]];
        assert!(!is_workflow_action_event(&tags));
    }

    /// The property buzz#22 adds: a foreign identity's action (someone else's
    /// workflow runner) is skipped just as surely as this identity's own —
    /// the marker is checked independently of authorship. This is what makes
    /// a cross-runner triggering pair terminate; the same-runner case is
    /// already covered by `is_own_event` (`a_self_matching_reply_would_fire_again_on_content_alone`
    /// exercises what would happen *without* that check).
    #[test]
    fn a_foreign_marked_event_never_reaches_plan_trigger() {
        let identity = "ab".repeat(32);
        let foreign_author = "cd".repeat(32);
        assert!(!is_own_event(&identity, &foreign_author));

        let tags = vec![
            vec!["h".to_string(), "eng".to_string()],
            vec!["client".to_string(), CLIENT_MARKER.to_string()],
        ];
        // walk_channel's real order: is_own_event, then is_workflow_action_event,
        // and only past both does plan_trigger ever get called.
        assert!(is_workflow_action_event(&tags));
    }

    // ─── buzz#22: schedule due-ness (fake clock, no wall-clock wait) ────────

    fn cron(expr: &str) -> cron::Schedule {
        expr.parse().unwrap()
    }

    #[test]
    fn a_schedule_is_not_due_the_instant_its_anchor_would_match() {
        // "every second" — if `since` counted as a possible fire itself
        // (inclusive rather than strictly-after), this would be due at the
        // same instant.
        let schedule = cron("* * * * * * *");
        assert!(!is_schedule_due(&schedule, 1_700_000_000, 1_700_000_000));
    }

    #[test]
    fn a_schedule_becomes_due_once_its_first_tick_after_the_anchor_passes() {
        let schedule = cron("* * * * * * *");
        // One second later, the tick strictly after the anchor
        // (1_700_000_000) has passed.
        assert!(is_schedule_due(&schedule, 1_700_000_000, 1_700_000_001));
    }

    #[test]
    fn a_schedule_is_not_due_again_immediately_after_firing() {
        let schedule = cron("* * * * * * *");
        assert!(!is_schedule_due(&schedule, 1_700_000_001, 1_700_000_001));
    }

    #[test]
    fn a_schedule_becomes_due_again_at_its_next_tick() {
        let schedule = cron("* * * * * * *");
        assert!(is_schedule_due(&schedule, 1_700_000_001, 1_700_000_002));
    }

    #[test]
    fn a_five_minute_schedule_is_not_due_one_minute_after_firing() {
        // "*/5 * * * *" normalized: every 5th minute, 0 seconds.
        let schedule = cron("0 */5 * * * * *");
        let fired_at = 1_700_000_000u64; // arbitrary anchor
        assert!(!is_schedule_due(&schedule, fired_at, fired_at + 60));
    }

    #[test]
    fn a_daily_schedule_is_due_the_day_after_it_last_fired() {
        let schedule = cron("0 0 9 * * * *"); // 09:00:00 UTC daily
        let fired_at = Utc
            .with_ymd_and_hms(2023, 11, 15, 9, 0, 0)
            .unwrap()
            .timestamp() as u64;
        let next_day_9am = fired_at + 24 * 3600;
        assert!(is_schedule_due(&schedule, fired_at, next_day_9am));
        assert!(!is_schedule_due(&schedule, fired_at, next_day_9am - 1));
    }

    /// The bug buzz#22 had to design around: anchoring the never-fired case
    /// to "now at this call" instead of a fixed point makes a schedule
    /// permanently un-fireable, because every check re-bases its own
    /// reference point to itself and "strictly after myself" is never true
    /// of the present instant. `fire_schedules` avoids this by anchoring to
    /// the process's start time, not to each call's own `now` — this test
    /// pins the property `is_schedule_due` itself must have for that to
    /// work: the same fixed `since` must eventually become due as `now`
    /// advances past it, not just at the moment it was chosen.
    #[test]
    fn a_fixed_anchor_eventually_becomes_due_as_now_advances() {
        let schedule = cron("* * * * * * *"); // every second
        let anchor = 1_700_000_000u64;
        assert!(!is_schedule_due(&schedule, anchor, anchor));
        assert!(is_schedule_due(&schedule, anchor, anchor + 1));
        assert!(is_schedule_due(&schedule, anchor, anchor + 5));
    }

    // ─── buzz#22: cross-channel action refuses without a held key ──────────

    #[tokio::test]
    async fn act_refuses_a_target_channel_the_runner_holds_no_key_for() {
        // A bogus sidecar URL is safe here: the refusal happens before any
        // network call, because `act` checks `keystore.sending_key` first.
        let client = SidecarClient::new("http://127.0.0.1:1".to_string()).unwrap();
        let keystore = AgentKeystore::open(std::path::PathBuf::from(
            "/nonexistent/agent-channel-keys.json",
        ))
        .unwrap();
        let result = act(
            &client,
            "ws://127.0.0.1:1",
            &keystore,
            "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a",
            ActAttempt::Reply("hi".to_string()),
        )
        .await;
        assert!(matches!(result, ActionResult::Refused { .. }));
    }

    // ─── buzz#52: add_reaction action ────────────────────────────────────────

    #[test]
    fn a_matching_message_may_fire_an_add_reaction_action() {
        let workflows = vec![workflow(
            "version: 1\nname: triage\ntrigger:\n  contains: todo\n\
action:\n  add_reaction:\n    emoji: eyes\n",
        )];
        let outcome = plan_trigger(
            true,
            &Opened::Plaintext("a todo for later".into()),
            &workflows,
            "eng",
        );
        assert_eq!(
            outcome,
            TriggerOutcome::Fire {
                workflow: "triage".to_string(),
                action: schema::ActionKind::AddReaction {
                    emoji: "eyes".to_string()
                },
                channel_override: None,
            }
        );
    }

    #[tokio::test]
    async fn act_also_refuses_an_add_reaction_without_a_held_key() {
        let client = SidecarClient::new("http://127.0.0.1:1".to_string()).unwrap();
        let keystore = AgentKeystore::open(std::path::PathBuf::from(
            "/nonexistent/agent-channel-keys.json",
        ))
        .unwrap();
        let result = act(
            &client,
            "ws://127.0.0.1:1",
            &keystore,
            "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a",
            ActAttempt::AddReaction {
                target_event_id: "ab".repeat(32),
                emoji: "eyes".to_string(),
            },
        )
        .await;
        assert!(matches!(result, ActionResult::Refused { .. }));
    }

    // ─── buzz#52: reaction_added trigger ─────────────────────────────────────

    #[test]
    fn reaction_target_reads_the_last_e_tag() {
        let tags = vec![
            vec!["e".to_string(), "old-target".to_string()],
            vec!["e".to_string(), "new-target".to_string()],
        ];
        assert_eq!(reaction_target(&tags).as_deref(), Some("new-target"));
    }

    #[test]
    fn reaction_target_is_none_without_an_e_tag() {
        let tags = vec![vec!["p".to_string(), "somebody".to_string()]];
        assert_eq!(reaction_target(&tags), None);
    }

    #[test]
    fn a_matching_emoji_fires_a_reaction_added_workflow() {
        let workflows = vec![workflow(
            "version: 1\nname: triage\ntrigger:\n  reaction_added: true\n  emoji: clipboard\n\
action:\n  add_reaction:\n    emoji: eyes\n",
        )];
        let outcome = plan_reaction_trigger("clipboard", &workflows, "eng");
        assert_eq!(
            outcome,
            TriggerOutcome::Fire {
                workflow: "triage".to_string(),
                action: schema::ActionKind::AddReaction {
                    emoji: "eyes".to_string()
                },
                channel_override: None,
            }
        );
    }

    #[test]
    fn a_non_matching_emoji_does_not_fire_a_filtered_reaction_added_workflow() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  reaction_added: true\n  emoji: clipboard\n\
action:\n  reply: noted\n",
        )];
        let outcome = plan_reaction_trigger("thumbsup", &workflows, "eng");
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NoMatch));
    }

    #[test]
    fn an_unfiltered_reaction_added_workflow_fires_on_any_emoji() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  reaction_added: true\naction:\n  reply: someone reacted\n",
        )];
        assert!(matches!(
            plan_reaction_trigger("anything", &workflows, "eng"),
            TriggerOutcome::Fire { .. }
        ));
    }

    #[test]
    fn a_reaction_added_workflow_scoped_to_another_channel_is_not_consulted() {
        let workflows = vec![workflow(concat!(
            "version: 1\n",
            "trigger:\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n  reaction_added: true\n",
            "action:\n  reply: noted\n",
        ))];
        let outcome = plan_reaction_trigger(
            "clipboard",
            &workflows,
            "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a",
        );
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NoMatch));
    }

    #[test]
    fn a_message_triggered_workflow_is_never_consulted_by_the_reaction_pass() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: clipboard\naction:\n  reply: hi\n",
        )];
        let outcome = plan_reaction_trigger("clipboard", &workflows, "eng");
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NoMatch));
    }

    #[test]
    fn channel_report_merge_sums_both_reports() {
        let mut a = ChannelReport {
            seen: 1,
            fired: 1,
            sent: 1,
            ..Default::default()
        };
        a.skip(SkipReason::NoMatch);
        let mut b = ChannelReport {
            seen: 2,
            dropped: 1,
            refused: 1,
            ..Default::default()
        };
        b.skip(SkipReason::NoMatch);
        b.skip(SkipReason::NoTarget);

        a.merge(b);
        assert_eq!(a.seen, 3);
        assert_eq!(a.fired, 1);
        assert_eq!(a.sent, 1);
        assert_eq!(a.dropped, 1);
        assert_eq!(a.refused, 1);
        assert_eq!(a.skipped.get(SkipReason::NoMatch.code()), Some(&2));
        assert_eq!(a.skipped.get(SkipReason::NoTarget.code()), Some(&1));
    }

    // ─── buzz#52: admin_added trigger ────────────────────────────────────────

    #[test]
    fn an_admin_added_workflow_fires_for_its_channel() {
        let workflows = vec![workflow(
            "version: 1\nname: welcome\ntrigger:\n  admin_added: true\n\
action:\n  reply: welcome aboard\n",
        )];
        let outcome = plan_admin_added_trigger(&workflows, "eng");
        assert_eq!(
            outcome,
            TriggerOutcome::Fire {
                workflow: "welcome".to_string(),
                action: schema::ActionKind::Reply("welcome aboard".to_string()),
                channel_override: None,
            }
        );
    }

    #[test]
    fn an_admin_added_workflow_scoped_to_another_channel_is_not_consulted() {
        let workflows = vec![workflow(concat!(
            "version: 1\n",
            "trigger:\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n  admin_added: true\n",
            "action:\n  reply: welcome\n",
        ))];
        let outcome = plan_admin_added_trigger(&workflows, "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a");
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NoMatch));
    }

    #[test]
    fn a_message_triggered_workflow_is_never_consulted_by_the_admin_added_pass() {
        let workflows = vec![workflow(
            "version: 1\ntrigger:\n  contains: hi\naction:\n  reply: yo\n",
        )];
        let outcome = plan_admin_added_trigger(&workflows, "eng");
        assert_eq!(outcome, TriggerOutcome::Skip(SkipReason::NoMatch));
    }
}
