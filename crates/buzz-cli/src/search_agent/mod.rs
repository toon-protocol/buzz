//! `buzz toon search-agent` — the first infrastructure agent-member (buzz#20).
//!
//! A long-running process that is a *member* of the channels it indexes, and
//! nothing more. It is admitted the same way a human is (buzz#19: an admin
//! gift-wraps the channel key to the identity the sidecar owns), it reads the
//! relay for free, it opens what its key ring opens, and it answers search
//! queries over a loopback HTTP endpoint.
//!
//! ## Membership by construction
//!
//! The reason this is the headline idiom of ADR 0001 is that there is no
//! access-control code here to get wrong. The agent cannot index a channel it
//! is not in, because indexing requires plaintext, plaintext requires a key,
//! and keys arrive only through [`crate::channel_key_grant::accept_grant`] —
//! which checks the wrap's seal signer against a signature-verified admin
//! list. Remove the agent and rotate, and it stops being able to read; there
//! is no separate "revoke the indexer" step, and no server-side ACL that could
//! disagree with the crypto.
//!
//! Three invariants carry that, and all three are tested:
//!
//! 1. **Only held-key channels are indexed.** [`plan_index`] refuses on
//!    `holds_key == false` before it looks at anything else, and the ingest
//!    loop only ever walks [`crate::agent_keystore::AgentKeystore::channels`].
//! 2. **Locked content is never indexed — not even as ciphertext.** A message
//!    sealed under an epoch the ring does not hold is skipped entirely. The
//!    cursor still advances past it, or a single unreadable message would stall
//!    the channel forever.
//! 3. **Rotation stops the index at the epoch boundary.** A rotation the agent
//!    was not re-wrapped for leaves its ring one epoch behind, so post-rotation
//!    messages come back `Locked` and are skipped, while everything it could
//!    already read stays indexed and searchable. That is Slack-export
//!    semantics, and it is deliberate: rotation protects the future, not the
//!    past (ADR 0001), and pretending otherwise would be security theatre —
//!    the agent already read those bytes.
//!
//! ## Two walks, one page primitive
//!
//! Per channel the agent maintains a backwards **backfill** walk and a
//! forwards **tail** walk, both built on [`fetch_window`]:
//!
//! - *Backfill* pages history with an inclusive `until` cursor — the Rust
//!   re-derivation of buzz#46's `assembleToonChannelWindowPage`, including its
//!   `(created_at, id)` strict-cursor filter and its rule that a page's
//!   fullness is judged from the raw deduped count, never the kept count. One
//!   page per cycle, so the index commits incrementally and a fresh agent is
//!   answering queries about recent history within seconds.
//! - *Tail* is also a backwards walk, but floored by `since` — and that is not
//!   an implementation detail. A naive `since`-only poll asks for the newest
//!   `limit` events; if more than `limit` arrived since the last cycle, the
//!   ones in the middle are skipped **permanently**, because the cursor jumps
//!   to the newest. Walking down from the head until a short page proves the
//!   window is exhausted is what makes the tail lossless.
//!
//! ## Restart and rebuild
//!
//! Cursors live in the same file as the documents and are written with them in
//! one atomic rename ([`crate::search_index::SearchIndex::save`]), so a restart
//! resumes exactly where the last committed cycle ended and a crash mid-cycle
//! costs a repeated cycle, never a skipped event. Delete the index and the
//! agent rebuilds it from relay history with no manual steps — the same code
//! path a first run takes, because a first run *is* the missing-index case.

mod server;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use nostr::Event;
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::agent_keystore::AgentKeystore;
use crate::channel_admins::tags_as_strings;
use crate::commands::toon::{open_message, sweep_inbox, Opened};
use crate::error::CliError;
use crate::search_index::{is_strictly_older, ChannelCursor, IndexedMessage, SearchIndex};
use crate::sidecar::SidecarClient;
use crate::toon_relay::{self, channel_history_filter};

use server::serve;

/// Loopback port the query endpoint binds by default. One above the sidecar's
/// 8787 so a developer running both does not have to think about it.
pub const DEFAULT_SEARCH_AGENT_PORT: u16 = 8788;

/// How many pages the tail walk will consume in one cycle before yielding.
///
/// A cap is needed so a channel with a huge burst cannot starve the others.
/// When it bites, the newest-cursor is deliberately *not* advanced: the next
/// cycle re-walks from the head, and the already-indexed prefix costs a hash
/// lookup per event rather than a decrypt. Re-fetching is cheap (reads are
/// free); skipping the middle of a burst is not recoverable.
const MAX_TAIL_PAGES: usize = 20;

/// Where the search agent's collaborators live.
pub struct SearchAgentOptions<'a> {
    pub sidecar_url: &'a str,
    pub relay_url: &'a str,
    pub keystore_path: Option<&'a str>,
    pub index_path: Option<&'a str>,
    pub bind: SocketAddr,
    pub poll_interval: Duration,
    pub page_size: u32,
    pub inbox_limit: u32,
    /// Run exactly one ingest cycle, print the report, and exit. This is what
    /// the tests drive, and it is also the honest way to prove "restart
    /// resumes" — two `--once` runs over the same index file.
    pub once: bool,
}

/// What one channel's ingest did, for the cycle report.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ChannelReport {
    pub indexed: usize,
    pub seen: usize,
    /// Skip reason code → count. Surfaced because "the agent is running and
    /// indexing nothing" has three very different causes, and an operator
    /// staring at `indexed: 0` needs to know which one — a rotation lockout
    /// (`locked`) reads nothing like a channel of empty messages.
    pub skipped: BTreeMap<&'static str, usize>,
    pub backfill_complete: bool,
}

impl ChannelReport {
    fn skip(&mut self, reason: SkipReason) {
        *self.skipped.entry(reason.code()).or_insert(0) += 1;
    }

    pub fn locked(&self) -> usize {
        self.skipped
            .get(SkipReason::Locked.code())
            .copied()
            .unwrap_or(0)
    }
}

/// What one cycle did across every held channel.
#[derive(Debug, Default)]
pub struct CycleReport {
    pub wraps_seen: usize,
    pub keys_accepted: usize,
    pub channels: BTreeMap<String, ChannelReport>,
    /// Per-channel transport failures. A relay hiccup on one channel must not
    /// abandon the others, or one bad channel silently freezes the whole index.
    pub errors: BTreeMap<String, String>,
}

impl CycleReport {
    pub fn indexed(&self) -> usize {
        self.channels.values().map(|c| c.indexed).sum()
    }

    pub fn to_json(&self, index: &SearchIndex) -> Value {
        json!({
            "wrapsSeen": self.wraps_seen,
            "keysAccepted": self.keys_accepted,
            "indexed": self.indexed(),
            "documents": index.document_count(),
            "channels": self.channels.iter().map(|(id, report)| json!({
                "channel": id,
                "seen": report.seen,
                "indexed": report.indexed,
                "locked": report.locked(),
                "skipped": report.skipped,
                "backfillComplete": report.backfill_complete,
            })).collect::<Vec<_>>(),
            "errors": self.errors.iter().map(|(id, error)| json!({
                "channel": id,
                "error": error,
            })).collect::<Vec<_>>(),
        })
    }
}

// ─── the indexing decision ───────────────────────────────────────────────────

/// Why a fetched event contributed nothing to the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The agent holds no key for the channel. Fail-closed, and checked before
    /// anything else — this is invariant 1.
    NotAMember,
    /// Sealed under an epoch (or a scheme) the ring cannot open. Invariant 2:
    /// the ciphertext is not indexed either.
    Locked,
    /// Opened, but there is no text to index.
    Empty,
}

impl SkipReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotAMember => "not-a-member",
            Self::Locked => "locked",
            Self::Empty => "empty",
        }
    }
}

/// Whether one opened event may enter the index, and as what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexPlan {
    Index {
        content: String,
        key_id: Option<String>,
    },
    Skip(SkipReason),
}

/// The privacy invariant, as a pure function.
///
/// Every byte of plaintext that reaches [`SearchIndex::insert`] passes through
/// here first, and this is the only place the three rules live. It takes
/// `holds_key` explicitly rather than deriving it, so the "not a member"
/// branch is reachable in a test without constructing a keystore — the control
/// channel in `tests/search_agent.rs` proves the same thing over the wire.
pub fn plan_index(holds_key: bool, opened: &Opened) -> IndexPlan {
    if !holds_key {
        return IndexPlan::Skip(SkipReason::NotAMember);
    }
    match opened {
        Opened::Locked { .. } => IndexPlan::Skip(SkipReason::Locked),
        Opened::Plaintext(content) if content.trim().is_empty() => {
            IndexPlan::Skip(SkipReason::Empty)
        }
        Opened::Decrypted { content, .. } if content.trim().is_empty() => {
            IndexPlan::Skip(SkipReason::Empty)
        }
        Opened::Plaintext(content) => IndexPlan::Index {
            content: content.clone(),
            key_id: None,
        },
        Opened::Decrypted { content, key_id } => IndexPlan::Index {
            content: content.clone(),
            key_id: Some(key_id.clone()),
        },
    }
}

// ─── relay paging ────────────────────────────────────────────────────────────

/// Fetch one page of a channel's messages and put it in relay order.
///
/// "Relay order" is `created_at DESC, id ASC` with duplicates collapsed by id —
/// the same total order `channelWindowStore.ts`'s `compareRelayOrder` defines,
/// because both walks depend on the oldest element of a page being a
/// well-defined cursor even when several events share a second.
pub async fn fetch_window(
    relay_url: &str,
    channel_id: &str,
    since: Option<u64>,
    until: Option<u64>,
    limit: u32,
) -> Result<Vec<Event>, CliError> {
    let filter = channel_history_filter(channel_id, limit, since, until);
    Ok(relay_order(toon_relay::fetch(relay_url, filter).await?))
}

/// Dedupe by id and sort into `created_at DESC, id ASC`.
pub fn relay_order(events: Vec<Event>) -> Vec<Event> {
    let mut by_id: BTreeMap<String, Event> = BTreeMap::new();
    for event in events {
        by_id.insert(event.id.to_hex(), event);
    }
    let mut ordered: Vec<Event> = by_id.into_values().collect();
    ordered.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then(a.id.to_hex().cmp(&b.id.to_hex()))
    });
    ordered
}

// ─── the ingest loop ─────────────────────────────────────────────────────────

/// Run the search agent: bind the query endpoint, then ingest on a timer.
pub async fn run(opts: SearchAgentOptions<'_>) -> Result<(), CliError> {
    let client = SidecarClient::new(opts.sidecar_url.to_string())?;
    let identity = client.status().await?.identity.nostr_pubkey;

    let mut keystore = AgentKeystore::open(AgentKeystore::resolve_path(opts.keystore_path)?)?;
    keystore.assert_identity(&identity)?;

    let mut index = SearchIndex::open(SearchIndex::resolve_path(opts.index_path)?);
    index.assert_identity(&identity)?;
    let index = Arc::new(RwLock::new(index));

    let bound = serve(opts.bind, Arc::clone(&index)).await?;
    {
        let index = index.read().await;
        println!(
            "{}",
            json!({
                "event": "search-agent-started",
                "identity": identity,
                "queryUrl": format!("http://{bound}"),
                "index": index.path().display().to_string(),
                "keystore": keystore.path().display().to_string(),
                "documents": index.document_count(),
                "relay": opts.relay_url,
            })
        );
    }

    loop {
        let report = cycle(&client, &opts, &identity, &mut keystore, &index).await?;
        println!(
            "{}",
            json!({
                "event": "search-agent-cycle",
                "report": report.to_json(&*index.read().await),
            })
        );
        if opts.once {
            return Ok(());
        }
        tokio::time::sleep(opts.poll_interval).await;
    }
}

/// One ingest cycle: collect keys, then walk every channel the agent holds one
/// for, then commit documents and cursors together.
async fn cycle(
    client: &SidecarClient,
    opts: &SearchAgentOptions<'_>,
    identity: &str,
    keystore: &mut AgentKeystore,
    index: &RwLock<SearchIndex>,
) -> Result<CycleReport, CliError> {
    let mut report = CycleReport::default();

    // 1. Admission, via the identical fold `buzz toon inbox` runs. New keys
    //    are what make a channel appear in the walk below for the first time.
    let sweep = sweep_inbox(client, opts.relay_url, identity, keystore, opts.inbox_limit).await?;
    report.wraps_seen = sweep.wraps_seen;
    report.keys_accepted = sweep.accepted.len();
    keystore.save()?;

    // 2. Walk each held channel. Reads are free, so the ordering here is about
    //    responsiveness, not cost: the tail (what a user is most likely to
    //    search for) is caught up before another page of old history is pulled.
    let channels: Vec<String> = keystore.channels().cloned().collect();
    for channel_id in channels {
        let ring = keystore.ring(&channel_id).to_vec();
        let cursor = index.read().await.cursor(&channel_id);

        match walk_channel(opts, &channel_id, &ring, cursor, index).await {
            Ok((documents, cursor, channel_report)) => {
                let mut index = index.write().await;
                for document in documents {
                    index.insert(document);
                }
                index.set_cursor(&channel_id, cursor);
                report.channels.insert(channel_id, channel_report);
            }
            Err(error) => {
                report.errors.insert(channel_id, error.to_string());
            }
        }
    }

    // 3. One atomic commit for the whole cycle. Documents and cursors land
    //    together or not at all; a crash before this point replays the cycle.
    index.read().await.save()?;
    Ok(report)
}

/// The tail walk plus at most one backfill page for one channel.
async fn walk_channel(
    opts: &SearchAgentOptions<'_>,
    channel_id: &str,
    ring: &[buzz_channel_crypto::ChannelKey],
    mut cursor: ChannelCursor,
    index: &RwLock<SearchIndex>,
) -> Result<(Vec<IndexedMessage>, ChannelCursor, ChannelReport), CliError> {
    let mut documents = Vec::new();
    let mut report = ChannelReport::default();
    let page = opts.page_size.max(1);

    // ── tail: walk down from the head until a short page, floored by `since` ──
    //
    // With no tail cursor yet there is nothing to be lossless *about*: the
    // head page contains the newest event by definition, and everything under
    // it belongs to the backfill walk below. Taking one page and stopping is
    // what keeps a first run from walking the whole channel twice.
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
            // The tail re-walks from the head every cycle, so most of what it
            // sees is already indexed. Skipping those before `ingest` saves
            // the NIP-44 open, which is the only expensive part of the loop.
            if index.read().await.contains(&event_id) {
                continue;
            }
            match ingest(event, channel_id, ring) {
                Ok(document) => documents.push(document),
                Err(reason) => report.skip(reason),
            }
        }

        match (full, boundary) {
            // A full page means there may be more below it; step the window
            // down. `until` is inclusive, so the boundary event returns and is
            // collapsed by the index's dedupe-on-id.
            (true, Some(oldest)) if since.is_some_and(|floor| oldest > floor) => {
                until = Some(oldest)
            }
            _ => {
                exhausted = true;
                break;
            }
        }
    }

    // Only a completed walk may advance the tail cursor: advancing after a
    // capped walk would strand every event between the cap and the head.
    if exhausted {
        if let Some((created_at, event_id)) = newest {
            cursor.observe_newest(created_at, &event_id);
        }
    }

    // ── backfill: one page of older history per cycle ────────────────────────
    if !cursor.backfill_complete {
        let events = fetch_window(
            opts.relay_url,
            channel_id,
            None,
            cursor.backfill_until(),
            page,
        )
        .await?;
        // Fullness is judged from the RAW deduped page, before the strict-cursor
        // and readability filters — buzz#46's load-bearing rule. Deciding from
        // the kept count would end the walk forever on a page that happens to
        // be entirely locked.
        let full = events.len() >= page as usize;
        let boundary = events
            .last()
            .map(|e| (e.created_at.as_secs(), e.id.to_hex()));

        for event in &events {
            let created_at = event.created_at.as_secs();
            let event_id = event.id.to_hex();
            if !is_strictly_older(created_at, &event_id, &cursor) {
                continue; // the inclusive-`until` re-delivery of the last boundary
            }
            report.seen += 1;
            if cursor.newest_created_at.is_none() {
                cursor.observe_newest(created_at, &event_id);
            }
            if index.read().await.contains(&event_id) {
                continue;
            }
            match ingest(event, channel_id, ring) {
                Ok(document) => documents.push(document),
                Err(reason) => report.skip(reason),
            }
        }

        match boundary {
            Some((created_at, event_id)) if full => cursor.advance_backfill(created_at, &event_id),
            // A short (or empty) page is the relay saying there is no more
            // history. An empty channel is exhausted, not unresolved.
            _ => cursor.backfill_complete = true,
        }
    }

    report.indexed = documents.len();
    report.backfill_complete = cursor.backfill_complete;
    Ok((documents, cursor, report))
}

/// Turn one relay event into an indexable document, or say why not.
fn ingest(
    event: &Event,
    channel_id: &str,
    ring: &[buzz_channel_crypto::ChannelKey],
) -> Result<IndexedMessage, SkipReason> {
    // An empty ring is "not a member": the loop only walks held channels, but
    // a key can fall out of the ring between the sweep and the walk, and the
    // fail-closed answer must not depend on the caller having checked.
    let opened = open_message(&tags_as_strings(event), &event.content, ring);
    match plan_index(!ring.is_empty(), &opened) {
        IndexPlan::Index { content, key_id } => Ok(IndexedMessage {
            event_id: event.id.to_hex(),
            channel_id: channel_id.to_string(),
            pubkey: event.pubkey.to_hex(),
            created_at: event.created_at.as_secs(),
            content,
            key_id,
        }),
        IndexPlan::Skip(reason) => Err(reason),
    }
}

#[cfg(test)]
mod tests {
    use buzz_channel_crypto::{channel_key_id, encryption_tag, seal, ChannelKey};
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    use super::*;

    const EPOCH0: ChannelKey = [0x11; 32];
    const EPOCH1: ChannelKey = [0x22; 32];

    fn sealed_event(key: &ChannelKey, body: &str, at: u64) -> Event {
        EventBuilder::new(Kind::Custom(9), seal(body, key))
            .tags(vec![
                Tag::parse(["h", "engineering"]).unwrap(),
                Tag::parse(encryption_tag(key)).unwrap(),
            ])
            .custom_created_at(Timestamp::from_secs(at))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    fn plain_event(body: &str, at: u64) -> Event {
        EventBuilder::new(Kind::Custom(9), body)
            .tags(vec![Tag::parse(["h", "engineering"]).unwrap()])
            .custom_created_at(Timestamp::from_secs(at))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    /// Invariant 1. Nothing about the message matters — a readable plaintext
    /// message in a channel the agent was never admitted to is still refused.
    #[test]
    fn a_channel_with_no_held_key_is_never_indexed() {
        assert_eq!(
            plan_index(false, &Opened::Plaintext("public roadmap".into())),
            IndexPlan::Skip(SkipReason::NotAMember)
        );
        assert_eq!(
            plan_index(
                false,
                &Opened::Decrypted {
                    content: "somehow opened".into(),
                    key_id: "462594b863f0be53".into(),
                }
            ),
            IndexPlan::Skip(SkipReason::NotAMember),
            "membership is checked before readability, so there is no ordering \
             in which an unheld channel's text reaches the index"
        );
    }

    /// Invariant 2. Locked content contributes nothing — and specifically not
    /// its ciphertext, which a "index what you have" implementation would
    /// happily store.
    #[test]
    fn locked_content_is_not_indexed_not_even_as_ciphertext() {
        let plan = plan_index(
            true,
            &Opened::Locked {
                key_id: Some(channel_key_id(&EPOCH1)),
            },
        );
        assert_eq!(plan, IndexPlan::Skip(SkipReason::Locked));

        // The same over a real event: the ring holds epoch 0 only.
        let event = sealed_event(&EPOCH1, "post-rotation secret", 200);
        let error = ingest(&event, "engineering", &[EPOCH0]).unwrap_err();
        assert_eq!(error, SkipReason::Locked);
        assert!(
            !event.content.contains("post-rotation secret"),
            "sanity: the wire content really is ciphertext"
        );
    }

    /// Invariant 3, at the unit layer: the epoch boundary is where indexing
    /// stops, and everything before it survives.
    #[test]
    fn rotation_stops_the_index_at_the_epoch_boundary() {
        let ring = [EPOCH0];
        let before = sealed_event(&EPOCH0, "the deploy token is in the vault", 100);
        let after = sealed_event(&EPOCH1, "the new deploy token", 200);

        let kept = ingest(&before, "engineering", &ring).unwrap();
        assert_eq!(kept.content, "the deploy token is in the vault");
        assert_eq!(kept.key_id.as_deref(), Some(&*channel_key_id(&EPOCH0)));
        assert_eq!(
            ingest(&after, "engineering", &ring).unwrap_err(),
            SkipReason::Locked,
            "rotation protects the future, not the past"
        );

        // A member that did get the new wrap reads both epochs.
        let member = [EPOCH1, EPOCH0];
        assert!(ingest(&before, "engineering", &member).is_ok());
        assert!(ingest(&after, "engineering", &member).is_ok());
    }

    #[test]
    fn an_empty_ring_fails_closed_even_for_plaintext() {
        let event = plain_event("public roadmap", 100);
        assert_eq!(
            ingest(&event, "engineering", &[]).unwrap_err(),
            SkipReason::NotAMember
        );
        assert!(ingest(&event, "engineering", &[EPOCH0]).is_ok());
    }

    #[test]
    fn a_blank_message_is_skipped_rather_than_indexed_as_nothing() {
        assert_eq!(
            plan_index(true, &Opened::Plaintext("   \n".into())),
            IndexPlan::Skip(SkipReason::Empty)
        );
        assert_eq!(
            plan_index(
                true,
                &Opened::Decrypted {
                    content: "".into(),
                    key_id: "462594b863f0be53".into(),
                }
            ),
            IndexPlan::Skip(SkipReason::Empty)
        );
    }

    #[test]
    fn skip_reason_codes_are_stable_and_distinct() {
        let all = [
            SkipReason::NotAMember,
            SkipReason::Locked,
            SkipReason::Empty,
        ];
        let mut codes: Vec<&str> = all.iter().map(|r| r.code()).collect();
        codes.sort_unstable();
        let count = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), count);
    }

    #[test]
    fn relay_order_dedupes_by_id_and_sorts_newest_first_then_id() {
        let a = plain_event("a", 100);
        let b = plain_event("b", 200);
        let c = plain_event("c", 100);
        let ordered = relay_order(vec![a.clone(), b.clone(), c.clone(), a.clone()]);

        assert_eq!(ordered.len(), 3, "the duplicate collapses");
        assert_eq!(ordered[0].id, b.id, "newest first");
        // The two same-second events are ordered by id ASC, so the oldest
        // element of the page is a well-defined cursor.
        let tail: Vec<String> = ordered[1..].iter().map(|e| e.id.to_hex()).collect();
        let mut expected = vec![a.id.to_hex(), c.id.to_hex()];
        expected.sort();
        assert_eq!(tail, expected);
    }
}
