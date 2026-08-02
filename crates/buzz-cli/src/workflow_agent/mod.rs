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
//! Two mechanisms, of unequal weight:
//!
//! 1. **[`is_own_event`] — the one that actually does the work.** An event
//!    authored by this identity is never evaluated, full stop, checked before
//!    a single byte of it is opened. A workflow whose reply text happens to
//!    match its own trigger (`contains: "hello"` replying `"hello back"`)
//!    therefore cannot loop: its own action event is the ineligible one, not
//!    the next incoming message.
//! 2. **The `["client", "buzz-workflow"]` marker tag** ([`CLIENT_MARKER`]),
//!    carried on every action event via `send_message`'s `extra_tags` — the
//!    same idempotency-tag idiom desktop's write path uses
//!    (`desktop/src-tauri/src/events.rs`). This buys nothing against a
//!    *single* runner re-triggering itself (rule 1 already closes that), but
//!    gives a future multi-runner deployment (buzz#22) something to filter on
//!    before rule 1 alone would have to do the work across identities.
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

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use buzz_channel_crypto::ChannelKey;
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
}

impl SkipReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotAMember => "not-a-member",
            Self::Locked => "locked",
            Self::Empty => "empty",
            Self::NoMatch => "no-match",
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
        reply: String,
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

/// Decide whether an already-opened, already-known-not-own event fires a
/// workflow.
///
/// Pure, like `crate::search_agent::plan_index` — the whole point is that
/// "membership is checked before readability, which is checked before
/// matching" is provable without a relay, a sidecar, or even a keystore in
/// the loop. Workflows are tried in file order (see
/// [`schema::load_workflows`]'s sort); the first whose channel scope and
/// condition both match wins, and later ones are not consulted.
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
        if workflow.condition.evaluate(text) {
            return TriggerOutcome::Fire {
                workflow: workflow.name.clone(),
                reply: workflow.reply.clone(),
            };
        }
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
    pub skipped: BTreeMap<&'static str, usize>,
}

impl ChannelReport {
    fn skip(&mut self, reason: SkipReason) {
        *self.skipped.entry(reason.code()).or_insert(0) += 1;
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

    pub fn to_json(&self) -> Value {
        json!({
            "wrapsSeen": self.wraps_seen,
            "keysAccepted": self.keys_accepted,
            "fired": self.fired(),
            "sent": self.sent(),
            "dropped": self.dropped(),
            "channels": self.channels.iter().map(|(id, report)| json!({
                "channel": id,
                "seen": report.seen,
                "fired": report.fired,
                "sent": report.sent,
                "dropped": report.dropped,
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
    Sent { event_id: String },
    Dropped { reason: String },
}

/// Full-jitter delay for attempt `attempt` (0-indexed).
fn backoff_delay(attempt: u32) -> Duration {
    let ceiling = PUBLISH_BACKOFF_SECS[(attempt as usize).min(PUBLISH_BACKOFF_SECS.len() - 1)];
    Duration::from_secs_f64(ceiling * rand::random::<f64>())
}

/// Post one workflow's reply, sealed through the same [`send_message`] path
/// `buzz toon send` uses, retrying a transient sidecar failure with backoff
/// before giving up loudly.
async fn act(
    client: &SidecarClient,
    relay_url: &str,
    keystore: &AgentKeystore,
    channel_id: &str,
    reply: String,
) -> ActionResult {
    let extra_tags = vec![vec!["client".to_string(), CLIENT_MARKER.to_string()]];
    let mut last_error = String::new();

    for attempt in 0..PUBLISH_MAX_ATTEMPTS {
        match send_message(
            client,
            relay_url,
            keystore,
            channel_id,
            reply.clone(),
            &extra_tags,
        )
        .await
        {
            Ok(outcome) => {
                return ActionResult::Sent {
                    event_id: outcome.receipt.event_id,
                }
            }
            Err(e) => {
                let retryable = crate::error::is_retryable_error(&e);
                last_error = e.to_string();
                let attempts_left = attempt + 1 < PUBLISH_MAX_ATTEMPTS;
                if !retryable || !attempts_left {
                    break;
                }
                eprintln!(
                    "{}",
                    json!({
                        "event": "workflow-action-retry",
                        "channel": channel_id,
                        "attempt": attempt + 1,
                        "maxAttempts": PUBLISH_MAX_ATTEMPTS,
                        "error": last_error,
                    })
                );
                tokio::time::sleep(backoff_delay(attempt)).await;
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
            })).collect::<Vec<_>>(),
            "state": state.path().display().to_string(),
            "keystore": keystore.path().display().to_string(),
            "relay": opts.relay_url,
        })
    );

    loop {
        let report = cycle(
            &client,
            &opts,
            &identity,
            &mut keystore,
            &mut state,
            &workflows,
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

    // 2. Walk each held channel's tail and act on what fires.
    let channels: Vec<String> = keystore.channels().cloned().collect();
    for channel_id in channels {
        let ring = keystore.ring(&channel_id).to_vec();
        match walk_channel(
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
            Ok(channel_report) => {
                report.channels.insert(channel_id, channel_report);
            }
            Err(error) => {
                report.errors.insert(channel_id, error.to_string());
            }
        }
    }

    // 3. One atomic commit for the whole cycle: the evaluated set and every
    //    cursor land together or not at all.
    state.save()?;
    Ok(report)
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

            let opened = open_message(&tags_as_strings(event), &event.content, ring);
            let outcome = plan_trigger(!ring.is_empty(), &opened, workflows, channel_id);
            match outcome {
                TriggerOutcome::Skip(reason) => report.skip(reason),
                TriggerOutcome::Fire { workflow, reply } => {
                    report.fired += 1;
                    match act(client, opts.relay_url, keystore, channel_id, reply).await {
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
                reply: "hi there".to_string(),
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
}
