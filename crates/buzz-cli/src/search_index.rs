//! The search agent's full-text index and its per-channel resume cursors
//! (buzz#20).
//!
//! ## Why this is a hand-rolled index and not tantivy
//!
//! The workspace carries no full-text engine: there is no `tantivy`, and no
//! `rusqlite` (so no FTS5) — the relay's search is Postgres `tsvector`
//! (`crates/buzz-search`), which an agent that must run next to a laptop
//! sidecar cannot use. So the choice was "add ~60 crates to every CI build of
//! this workspace" versus "write the ~350 lines an agent-scale corpus needs".
//!
//! The corpus here is *one agent's* channel messages — thousands to low
//! millions of short documents, all resident, single-writer, no concurrent
//! readers. That is squarely inside what a BTreeMap-backed inverted index with
//! real BM25 handles well, and it buys three things that matter more than raw
//! throughput for this ticket:
//!
//! 1. **The privacy invariant is provable.** [`SearchIndex::insert`] is the
//!    only path by which a byte of plaintext enters the index, and it takes an
//!    already-opened [`IndexedMessage`]. There is no segment writer, no
//!    background merge, no temp file that a crash could leave holding text the
//!    agent was not entitled to.
//! 2. **The cursor commits with the documents.** Resume state and documents
//!    live in one file written atomically (temp + rename), so a crash can
//!    never leave a cursor ahead of the content it claims to cover. With an
//!    external index that is a two-phase commit problem.
//! 3. **No C toolchain, no build-time cost** on a gate that already builds a
//!    Tauri app twice.
//!
//! The seam is narrow on purpose — [`SearchIndex`] exposes `insert`, `search`,
//! `cursor`, `set_cursor`, `save` and nothing else — so swapping in tantivy
//! later is a module replacement, not a refactor. See the PR for the
//! follow-up.
//!
//! ## Ranking
//!
//! Okapi BM25 (`k1 = 1.2`, `b = 0.75`) over a `simple`-style tokenizer:
//! lowercase, split on non-alphanumeric. That deliberately matches
//! `crates/buzz-search`'s `to_tsvector('simple', …)` — no stemming, no stop
//! words — so a query that finds a message through the relay finds it through
//! the agent.
//!
//! The trailing query term is **prefix**-matched, mirroring the `search_mode:
//! "prefix"` the desktop topbar sends (see
//! `desktop/src-tauri/src/commands/messages.rs`'s
//! `build_search_messages_filter`): the topbar is a typeahead, and a user who
//! has typed `depl` expects `deploy`. Postings are a `BTreeMap`, so a prefix
//! expansion is a range scan rather than a vocabulary walk.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// On-disk format version. Unlike the keystore — whose bytes are irreplaceable
/// membership — an index is *derived* state: a version it does not understand
/// is discarded and rebuilt from the relay, never an error. That is also the
/// upgrade path for a change to the tokenizer or the stored fields.
const INDEX_VERSION: u32 = 1;

/// Default index file name under the agent's data dir.
const INDEX_FILE: &str = "search-index.json";

/// BM25 term-frequency saturation.
const BM25_K1: f64 = 1.2;
/// BM25 length normalisation.
const BM25_B: f64 = 0.75;

/// A token longer than this is truncated. Guards the vocabulary against a
/// pasted base64 blob turning into one enormous unique term per message.
const MAX_TOKEN_CHARS: usize = 64;

/// One indexed message: the plaintext an agent was entitled to read, plus the
/// envelope fields the desktop's `SearchHit` needs to render and navigate.
///
/// A value of this type existing at all is a claim that the agent held a key
/// for `channel_id` (or that the message was never sealed) — see
/// [`crate::search_agent::plan_index`], the only thing that builds one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedMessage {
    pub event_id: String,
    pub channel_id: String,
    pub pubkey: String,
    pub created_at: u64,
    /// The opened plaintext. Never ciphertext, never a locked placeholder.
    pub content: String,
    /// The epoch this message was sealed under, or `None` if it was plaintext.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

/// How far the agent has walked one channel, in both directions.
///
/// Both halves are needed because the two walks are different shapes: history
/// is paged *backwards* with an `until` cursor until it runs out, and new
/// messages arrive *forwards* and are polled with `since`. Persisting only one
/// would make a restart either re-read the whole channel or miss its middle.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCursor {
    /// Newest `(created_at, event_id)` indexed — the forward tail's `since`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_event_id: Option<String>,
    /// Oldest `(created_at, event_id)` reached by the backwards walk — the
    /// next page's `until`. `None` means the walk has not started, which is
    /// the head of the channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backfill_created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backfill_event_id: Option<String>,
    /// Set once a short page proves the relay has no more history to give.
    #[serde(default)]
    pub backfill_complete: bool,
}

impl ChannelCursor {
    /// The `until` a backfill page should ask for, or `None` for the head page.
    pub fn backfill_until(&self) -> Option<u64> {
        self.backfill_created_at
    }

    /// The `since` a tail poll should ask for. Inclusive in NIP-01, so the
    /// newest known event comes back every poll; the index dedupes by id.
    pub fn tail_since(&self) -> Option<u64> {
        self.newest_created_at
    }

    /// Advance the forward tail if `(created_at, event_id)` is newer than what
    /// is recorded. Monotonic: a late-arriving old event never rewinds it.
    pub fn observe_newest(&mut self, created_at: u64, event_id: &str) {
        let newer = match (self.newest_created_at, self.newest_event_id.as_deref()) {
            (None, _) => true,
            (Some(at), _) if created_at > at => true,
            // Same second: the relay-order tiebreak is id ASC, so a *smaller*
            // id is newer in the ordering `compareRelayOrder` defines.
            (Some(at), Some(id)) if created_at == at => event_id < id,
            _ => false,
        };
        if newer {
            self.newest_created_at = Some(created_at);
            self.newest_event_id = Some(event_id.to_string());
        }
    }

    /// Move the backwards walk to the boundary of the page just consumed.
    pub fn advance_backfill(&mut self, created_at: u64, event_id: &str) {
        self.backfill_created_at = Some(created_at);
        self.backfill_event_id = Some(event_id.to_string());
    }
}

/// Whether `(created_at, event_id)` is strictly older than the backfill
/// boundary — the Rust twin of `channelWindowStore.ts`'s `isStrictlyOlder`.
///
/// NIP-01's `until` is *inclusive* and second-granular, so every page after
/// the first re-delivers the event the previous page ended on. Relay order is
/// `created_at DESC, id ASC`, so "strictly older" is the strict complement of
/// that: an earlier second, or the same second with a larger id.
pub fn is_strictly_older(created_at: u64, event_id: &str, cursor: &ChannelCursor) -> bool {
    let (Some(at), Some(id)) = (
        cursor.backfill_created_at,
        cursor.backfill_event_id.as_deref(),
    ) else {
        return true; // No boundary yet: the head page keeps everything.
    };
    created_at < at || (created_at == at && event_id > id)
}

/// One search result, in BM25-relevance order.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub message: IndexedMessage,
    pub score: f64,
}

/// Optional narrowing filters for [`SearchIndex::search`], applied on top of
/// the channel scope. All three default to "no restriction" — an omitted
/// filter matches everything, exactly like an omitted channel would leak
/// everything if channel scope were not already required.
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchFilters<'a> {
    /// Hex pubkeys the `from:` operator narrowed to. Empty means any author.
    pub authors: &'a [String],
    /// Inclusive lower bound on `created_at` (`after:`).
    pub since: Option<u64>,
    /// Inclusive upper bound on `created_at` (`before:`).
    pub until: Option<u64>,
}

impl SearchFilters<'_> {
    fn matches(&self, doc: &IndexedMessage) -> bool {
        (self.authors.is_empty() || self.authors.iter().any(|a| a == &doc.pubkey))
            && self.since.is_none_or(|floor| doc.created_at >= floor)
            && self.until.is_none_or(|cap| doc.created_at <= cap)
    }
}

/// Serialized form. Postings are *not* persisted: they are a pure function of
/// the documents and the tokenizer, so recomputing them on load costs one pass
/// and buys the freedom to change tokenization without an incompatible file.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexFile {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    #[serde(default)]
    channels: BTreeMap<String, ChannelCursor>,
    #[serde(default)]
    documents: Vec<IndexedMessage>,
}

/// The agent's index: documents keyed by event id, an inverted postings list,
/// and the resume cursors that commit with them.
#[derive(Debug)]
pub struct SearchIndex {
    path: PathBuf,
    identity: Option<String>,
    /// event id → document.
    docs: BTreeMap<String, IndexedMessage>,
    /// event id → token count, for BM25 length normalisation.
    lengths: HashMap<String, u32>,
    /// term → (event id → term frequency). `BTreeMap` at the top level so a
    /// prefix query is a range scan.
    postings: BTreeMap<String, HashMap<String, u32>>,
    /// channel id → resume state.
    cursors: BTreeMap<String, ChannelCursor>,
}

impl SearchIndex {
    /// Resolve the index path: an explicit override wins, else
    /// `<data-dir>/buzz/search-index.json`.
    ///
    /// The *data* dir, not the config dir the keystore uses: an index is
    /// regenerable cache, and a user who deletes it loses nothing but the time
    /// to rebuild. Keys are not, and live elsewhere on purpose.
    pub fn resolve_path(override_path: Option<&str>) -> Result<PathBuf, CliError> {
        if let Some(path) = override_path {
            return Ok(PathBuf::from(path));
        }
        let data = dirs::data_dir().ok_or_else(|| {
            CliError::Other(
                "could not resolve a platform data directory for the search index — \
pass --index or set BUZZ_SEARCH_INDEX"
                    .to_string(),
            )
        })?;
        Ok(data.join("buzz").join(INDEX_FILE))
    }

    /// Open the index at `path`, or start an empty one.
    ///
    /// "Empty" covers three cases that are deliberately indistinguishable to
    /// the caller, because all three have the same remedy — rebuild from the
    /// relay: the file does not exist, the file is a version this build does
    /// not understand, and the file is corrupt. The one thing this never does
    /// is fail: an agent that cannot start because its cache is bad is worse
    /// than an agent that spends a minute re-reading a public relay.
    pub fn open(path: PathBuf) -> Self {
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<IndexFile>(&raw).ok())
            .filter(|file| file.version == INDEX_VERSION);

        let mut index = Self {
            path,
            identity: None,
            docs: BTreeMap::new(),
            lengths: HashMap::new(),
            postings: BTreeMap::new(),
            cursors: BTreeMap::new(),
        };
        let Some(file) = file else { return index };

        index.identity = file.identity;
        index.cursors = file.channels;
        for doc in file.documents {
            index.insert(doc);
        }
        index
    }

    /// Bind the index to a sidecar identity, or refuse when it already belongs
    /// to a different one — the same guard [`crate::agent_keystore`] applies,
    /// for the same reason: one agent's plaintext must not end up answering
    /// another agent's queries.
    pub fn assert_identity(&mut self, pubkey: &str) -> Result<(), CliError> {
        let pubkey = pubkey.trim().to_ascii_lowercase();
        match self.identity.as_deref() {
            Some(existing) if existing != pubkey => Err(CliError::Usage(format!(
                "the search index at {} belongs to identity {existing}, but this sidecar is \
{pubkey} — point --index / BUZZ_SEARCH_INDEX at this agent's own file",
                self.path.display()
            ))),
            _ => {
                self.identity = Some(pubkey);
                Ok(())
            }
        }
    }

    /// Add or replace a document.
    ///
    /// **This is the only way plaintext enters the index.** Everything that
    /// decides *whether* a message may be indexed lives in
    /// [`crate::search_agent::plan_index`]; everything downstream of here
    /// assumes the decision was made.
    ///
    /// Replacing an existing id retracts its old postings first, so a
    /// re-indexed message never leaves ghost terms behind.
    pub fn insert(&mut self, message: IndexedMessage) {
        self.remove(&message.event_id);

        let tokens = tokenize(&message.content);
        let mut frequencies: HashMap<String, u32> = HashMap::new();
        for token in &tokens {
            *frequencies.entry(token.clone()).or_insert(0) += 1;
        }
        for (term, tf) in frequencies {
            self.postings
                .entry(term)
                .or_default()
                .insert(message.event_id.clone(), tf);
        }
        self.lengths
            .insert(message.event_id.clone(), tokens.len() as u32);
        self.docs.insert(message.event_id.clone(), message);
    }

    /// Drop a document and its postings. Used by [`Self::insert`] to make
    /// re-indexing idempotent, and by [`Self::forget_channel`].
    fn remove(&mut self, event_id: &str) {
        let Some(existing) = self.docs.remove(event_id) else {
            return;
        };
        self.lengths.remove(event_id);
        for term in tokenize(&existing.content) {
            let Some(entry) = self.postings.get_mut(&term) else {
                continue;
            };
            entry.remove(event_id);
            if entry.is_empty() {
                self.postings.remove(&term);
            }
        }
    }

    /// Whether this event id is already indexed — the cheap check the ingest
    /// loop runs before spending a decrypt.
    pub fn contains(&self, event_id: &str) -> bool {
        self.docs.contains_key(event_id)
    }

    pub fn document_count(&self) -> usize {
        self.docs.len()
    }

    /// Channels this index holds documents or a cursor for.
    pub fn channels(&self) -> BTreeSet<String> {
        self.cursors
            .keys()
            .cloned()
            .chain(self.docs.values().map(|doc| doc.channel_id.clone()))
            .collect()
    }

    pub fn cursor(&self, channel_id: &str) -> ChannelCursor {
        self.cursors.get(channel_id).cloned().unwrap_or_default()
    }

    pub fn set_cursor(&mut self, channel_id: &str, cursor: ChannelCursor) {
        self.cursors.insert(channel_id.to_string(), cursor);
    }

    /// Search `query` within `channels`, additionally narrowed by `filters`.
    ///
    /// `channels` is the caller's claim of what it is entitled to see, and it
    /// is **required**: an empty slice returns nothing rather than everything.
    /// Fail-closed is the only safe default for a scope argument — a caller
    /// that forgot to pass one gets zero results, not another channel's
    /// plaintext. `filters` narrows further (authors / date range) and can
    /// only ever narrow — it is applied in the same scope check as the
    /// channel membership, never as a separate pass over already-scoped hits.
    pub fn search(
        &self,
        query: &str,
        channels: &[String],
        filters: &SearchFilters<'_>,
        limit: usize,
    ) -> Vec<SearchHit> {
        let terms = tokenize(query);
        if terms.is_empty() || channels.is_empty() || limit == 0 {
            return Vec::new();
        }
        let scope: BTreeSet<&str> = channels.iter().map(String::as_str).collect();

        let total_docs = self.docs.len() as f64;
        let total_len: u64 = self.lengths.values().map(|n| u64::from(*n)).sum();
        let avg_len = if self.docs.is_empty() {
            1.0
        } else {
            (total_len as f64 / total_docs).max(1.0)
        };

        // AND semantics across terms, matching `websearch_to_tsquery`'s
        // treatment of bare words. The last term is prefix-expanded.
        let last = terms.len() - 1;
        let mut scores: HashMap<&str, f64> = HashMap::new();
        for (position, term) in terms.iter().enumerate() {
            let matches = if position == last {
                self.expand_prefix(term)
            } else {
                self.postings
                    .get(term)
                    .into_iter()
                    .collect::<Vec<&HashMap<String, u32>>>()
            };
            if matches.is_empty() {
                return Vec::new(); // A term nothing matches ends the conjunction.
            }

            // One term's contribution per document: the best of its prefix
            // expansions, so `depl` scores as the strongest of `deploy` /
            // `deployment` rather than the sum of both.
            let mut best: HashMap<&str, f64> = HashMap::new();
            for postings in matches {
                let df = postings
                    .keys()
                    .filter(|id| self.in_scope(id, &scope, filters))
                    .count() as f64;
                if df == 0.0 {
                    continue;
                }
                let idf = (1.0 + (total_docs - df + 0.5) / (df + 0.5)).ln();
                for (event_id, tf) in postings {
                    if !self.in_scope(event_id, &scope, filters) {
                        continue;
                    }
                    let length = f64::from(*self.lengths.get(event_id).unwrap_or(&1));
                    let tf = f64::from(*tf);
                    let score = idf * (tf * (BM25_K1 + 1.0))
                        / (tf + BM25_K1 * (1.0 - BM25_B + BM25_B * length / avg_len));
                    let slot = best.entry(event_id.as_str()).or_insert(f64::MIN);
                    *slot = slot.max(score);
                }
            }
            if best.is_empty() {
                return Vec::new();
            }

            if position == 0 {
                scores = best;
            } else {
                scores.retain(|id, running| match best.get(id) {
                    Some(add) => {
                        *running += add;
                        true
                    }
                    None => false,
                });
                if scores.is_empty() {
                    return Vec::new();
                }
            }
        }

        let mut hits: Vec<SearchHit> = scores
            .into_iter()
            .filter_map(|(event_id, score)| {
                self.docs.get(event_id).map(|message| SearchHit {
                    message: message.clone(),
                    score,
                })
            })
            .collect();
        // Relevance, then recency, then id — total and stable, so two runs
        // over the same corpus return the same page.
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.message.created_at.cmp(&a.message.created_at))
                .then(a.message.event_id.cmp(&b.message.event_id))
        });
        hits.truncate(limit);
        hits
    }

    fn in_scope(
        &self,
        event_id: &str,
        scope: &BTreeSet<&str>,
        filters: &SearchFilters<'_>,
    ) -> bool {
        self.docs
            .get(event_id)
            .is_some_and(|doc| scope.contains(doc.channel_id.as_str()) && filters.matches(doc))
    }

    /// Every postings list whose term starts with `prefix`, as a range scan.
    fn expand_prefix(&self, prefix: &str) -> Vec<&HashMap<String, u32>> {
        self.postings
            .range(prefix.to_string()..)
            .take_while(|(term, _)| term.starts_with(prefix))
            .map(|(_, postings)| postings)
            .collect()
    }

    /// Write documents and cursors to disk in one atomic replacement.
    ///
    /// Temp file in the same directory, owner-only, `fsync`, then `rename`.
    /// A rename within a directory is atomic, so a reader — or a restart after
    /// a crash mid-write — sees either the whole previous index or the whole
    /// new one, never a cursor that has advanced past documents that were
    /// never written. That single-file coupling is the entire answer to
    /// "a crash never skips events".
    pub fn save(&self) -> Result<(), CliError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::Other(format!("failed to create {}: {e}", parent.display()))
            })?;
        }
        let file = IndexFile {
            version: INDEX_VERSION,
            identity: self.identity.clone(),
            channels: self.cursors.clone(),
            documents: self.docs.values().cloned().collect(),
        };
        let json = serde_json::to_string(&file)
            .map_err(|e| CliError::Other(format!("failed to serialize the search index: {e}")))?;

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

/// Split text into index terms: lowercase, alphanumeric runs.
///
/// Matches Postgres `to_tsvector('simple', …)` closely enough that the relay
/// and the agent agree on what a word is — no stemming, no stop-word list.
/// Unicode-aware via `char::is_alphanumeric`, so a non-ASCII channel is
/// searchable in its own script rather than tokenizing to nothing.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if current.chars().count() < MAX_TOKEN_CHARS {
                current.extend(ch.to_lowercase());
            }
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
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

    fn message(event_id: &str, channel: &str, at: u64, content: &str) -> IndexedMessage {
        message_by(event_id, channel, "ab".repeat(32), at, content)
    }

    fn message_by(
        event_id: &str,
        channel: &str,
        pubkey: String,
        at: u64,
        content: &str,
    ) -> IndexedMessage {
        IndexedMessage {
            event_id: event_id.to_string(),
            channel_id: channel.to_string(),
            pubkey,
            created_at: at,
            content: content.to_string(),
            key_id: Some("462594b863f0be53".to_string()),
        }
    }

    fn scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(INDEX_FILE);
        (dir, path)
    }

    fn ids(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter()
            .map(|hit| hit.message.event_id.as_str())
            .collect()
    }

    /// Shorthand for "no author/date narrowing", used by every test that
    /// predates the filters and is not testing them.
    fn no_filters() -> SearchFilters<'static> {
        SearchFilters::default()
    }

    #[test]
    fn tokenizes_to_lowercase_alphanumeric_runs() {
        assert_eq!(
            tokenize("Rotate the DEPLOY-token, now!"),
            vec!["rotate", "the", "deploy", "token", "now"]
        );
        assert_eq!(tokenize("   "), Vec::<String>::new());
        // Unicode survives rather than tokenizing to nothing.
        assert_eq!(tokenize("привет мир"), vec!["привет", "мир"]);
    }

    #[test]
    fn an_absurdly_long_token_is_truncated_not_stored_whole() {
        let blob = "a".repeat(500);
        let tokens = tokenize(&blob);
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].chars().count(), MAX_TOKEN_CHARS);
    }

    #[test]
    fn a_missing_file_opens_as_an_empty_index() {
        let (_dir, path) = scratch();
        let index = SearchIndex::open(path);
        assert_eq!(index.document_count(), 0);
        assert!(index.cursor("engineering").backfill_until().is_none());
    }

    #[test]
    fn an_indexed_message_is_findable_within_its_channel() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        index.insert(message(
            "e1",
            "engineering",
            100,
            "the deploy token is in the vault",
        ));

        let hits = index.search("deploy", &["engineering".to_string()], &no_filters(), 10);
        assert_eq!(ids(&hits), vec!["e1"]);
        assert!(hits[0].score > 0.0);
        assert_eq!(hits[0].message.content, "the deploy token is in the vault");
    }

    /// The acceptance criterion, at the index layer: a caller may only see
    /// channels it named, and naming none sees nothing.
    #[test]
    fn a_channel_outside_the_requested_scope_never_appears() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        index.insert(message("e1", "engineering", 100, "deploy token rotation"));
        index.insert(message("c1", "control", 100, "deploy token rotation"));

        assert_eq!(
            ids(&index.search("deploy", &["engineering".to_string()], &no_filters(), 10)),
            vec!["e1"],
            "the control channel's identical text must not leak into a scoped query"
        );
        assert!(
            index.search("deploy", &[], &no_filters(), 10).is_empty(),
            "an empty scope is zero results, never every result"
        );
    }

    #[test]
    fn terms_are_anded_and_the_last_one_is_prefix_matched() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        index.insert(message("e1", "eng", 100, "rotate the deploy token"));
        index.insert(message("e2", "eng", 100, "rotate the standup time"));
        let scope = vec!["eng".to_string()];

        assert_eq!(
            ids(&index.search("rotate deploy", &scope, &no_filters(), 10)),
            vec!["e1"]
        );
        assert!(index
            .search("rotate missing", &scope, &no_filters(), 10)
            .is_empty());
        // Typeahead: a partial trailing word still finds the message.
        assert_eq!(
            ids(&index.search("rotate depl", &scope, &no_filters(), 10)),
            vec!["e1"]
        );
        // But a partial *leading* word is exact — only the tail is a prefix.
        assert!(index
            .search("rot deploy", &scope, &no_filters(), 10)
            .is_empty());
    }

    #[test]
    fn ranking_prefers_the_denser_match_and_is_stable() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        index.insert(message("dense", "eng", 100, "deploy deploy deploy"));
        index.insert(message(
            "sparse",
            "eng",
            200,
            "deploy is one word among a great many other unrelated words here",
        ));
        let hits = index.search("deploy", &["eng".to_string()], &no_filters(), 10);
        assert_eq!(
            ids(&hits),
            vec!["dense", "sparse"],
            "BM25 length normalisation puts the concentrated match first"
        );
        assert_eq!(
            ids(&index.search("deploy", &["eng".to_string()], &no_filters(), 1)),
            vec!["dense"]
        );
    }

    #[test]
    fn reindexing_a_message_leaves_no_ghost_terms() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        index.insert(message("e1", "eng", 100, "original wording"));
        index.insert(message("e1", "eng", 100, "corrected wording"));
        let scope = vec!["eng".to_string()];

        assert_eq!(index.document_count(), 1);
        assert!(index
            .search("original", &scope, &no_filters(), 10)
            .is_empty());
        assert_eq!(
            ids(&index.search("corrected", &scope, &no_filters(), 10)),
            vec!["e1"]
        );
    }

    #[test]
    fn the_authors_filter_narrows_to_the_named_pubkeys() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        let alice = "aa".repeat(32);
        let bob = "bb".repeat(32);
        index.insert(message_by("e1", "eng", alice.clone(), 100, "deploy token"));
        index.insert(message_by("e2", "eng", bob.clone(), 100, "deploy token"));
        let scope = vec!["eng".to_string()];

        let filters = SearchFilters {
            authors: &[alice.clone()],
            ..Default::default()
        };
        assert_eq!(
            ids(&index.search("deploy", &scope, &filters, 10)),
            vec!["e1"]
        );

        let both = SearchFilters {
            authors: &[alice, bob],
            ..Default::default()
        };
        let both_hits = index.search("deploy", &scope, &both, 10);
        let mut both_ids = ids(&both_hits);
        both_ids.sort_unstable();
        assert_eq!(both_ids, vec!["e1", "e2"]);

        let nobody = SearchFilters {
            authors: &["cc".repeat(32)],
            ..Default::default()
        };
        assert!(index.search("deploy", &scope, &nobody, 10).is_empty());
    }

    #[test]
    fn the_since_and_until_filters_bound_the_created_at_range() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        index.insert(message("old", "eng", 100, "deploy token"));
        index.insert(message("mid", "eng", 200, "deploy token"));
        index.insert(message("new", "eng", 300, "deploy token"));
        let scope = vec!["eng".to_string()];

        let since = SearchFilters {
            since: Some(200),
            ..Default::default()
        };
        let since_hits = index.search("deploy", &scope, &since, 10);
        let mut since_ids = ids(&since_hits);
        since_ids.sort_unstable();
        assert_eq!(since_ids, vec!["mid", "new"]);

        let until = SearchFilters {
            until: Some(200),
            ..Default::default()
        };
        let until_hits = index.search("deploy", &scope, &until, 10);
        let mut until_ids = ids(&until_hits);
        until_ids.sort_unstable();
        assert_eq!(until_ids, vec!["mid", "old"]);

        // Both bounds are inclusive and compose to a closed range.
        let bounded = SearchFilters {
            since: Some(200),
            until: Some(200),
            ..Default::default()
        };
        assert_eq!(
            ids(&index.search("deploy", &scope, &bounded, 10)),
            vec!["mid"]
        );
    }

    #[test]
    fn all_three_filters_combine_with_a_text_query_and_a_channel_scope() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path);
        let alice = "aa".repeat(32);
        let bob = "bb".repeat(32);
        index.insert(message_by(
            "match",
            "eng",
            alice.clone(),
            200,
            "the deploy token rotated",
        ));
        // Wrong author.
        index.insert(message_by("wrong-author", "eng", bob, 200, "deploy token"));
        // Right author, outside the date window.
        index.insert(message_by(
            "wrong-date",
            "eng",
            alice.clone(),
            999,
            "deploy token",
        ));
        // Right author and date, wrong channel.
        index.insert(message_by(
            "wrong-channel",
            "control",
            alice.clone(),
            200,
            "deploy token",
        ));

        let filters = SearchFilters {
            authors: &[alice],
            since: Some(150),
            until: Some(250),
        };
        assert_eq!(
            ids(&index.search("deploy", &["eng".to_string()], &filters, 10)),
            vec!["match"]
        );
    }

    #[test]
    fn documents_and_cursors_round_trip_through_one_atomic_save() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path.clone());
        index.insert(message("e1", "eng", 100, "the deploy token"));
        let mut cursor = ChannelCursor::default();
        cursor.observe_newest(100, "e1");
        cursor.advance_backfill(100, "e1");
        cursor.backfill_complete = true;
        index.set_cursor("eng", cursor.clone());
        index.assert_identity(&"AB".repeat(32)).unwrap();
        index.save().unwrap();

        let reopened = SearchIndex::open(path.clone());
        assert_eq!(reopened.document_count(), 1);
        assert_eq!(reopened.cursor("eng"), cursor);
        assert_eq!(
            ids(&reopened.search("deploy", &["eng".to_string()], &no_filters(), 10)),
            vec!["e1"],
            "postings are rebuilt on load, so the reopened index is searchable"
        );
        // No temp file left behind by the rename.
        assert!(!path.with_extension("tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_saved_index_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path.clone());
        index.insert(message(
            "e1",
            "eng",
            100,
            "the deploy token is in the vault",
        ));
        index.save().unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the index holds decrypted private-channel text"
        );
    }

    #[test]
    fn a_corrupt_or_future_index_rebuilds_instead_of_failing() {
        let (_dir, path) = scratch();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(SearchIndex::open(path.clone()).document_count(), 0);

        std::fs::write(&path, r#"{"version": 99, "documents": []}"#).unwrap();
        let index = SearchIndex::open(path.clone());
        assert_eq!(index.document_count(), 0);
        assert!(
            index.cursor("eng").backfill_until().is_none(),
            "a version this build cannot read is discarded whole — cursors included, \
so the rebuild starts from the head rather than resuming into a gap"
        );
    }

    #[test]
    fn an_index_bound_to_another_identity_is_refused() {
        let (_dir, path) = scratch();
        let mut index = SearchIndex::open(path.clone());
        index.assert_identity(&"11".repeat(32)).unwrap();
        index.save().unwrap();

        let mut reopened = SearchIndex::open(path);
        assert!(reopened.assert_identity(&"22".repeat(32)).is_err());
        assert!(reopened.assert_identity(&"11".repeat(32)).is_ok());
    }

    #[test]
    fn the_newest_cursor_is_monotonic_and_breaks_ties_by_id() {
        let mut cursor = ChannelCursor::default();
        cursor.observe_newest(100, "bbbb");
        assert_eq!(cursor.tail_since(), Some(100));

        cursor.observe_newest(50, "aaaa");
        assert_eq!(
            cursor.tail_since(),
            Some(100),
            "a late-arriving old event must not rewind the tail"
        );

        // Same second: relay order is id ASC, so the smaller id is newer.
        cursor.observe_newest(100, "aaaa");
        assert_eq!(cursor.newest_event_id.as_deref(), Some("aaaa"));
        cursor.observe_newest(100, "cccc");
        assert_eq!(cursor.newest_event_id.as_deref(), Some("aaaa"));
    }

    #[test]
    fn the_strict_cursor_predicate_drops_the_inclusive_until_boundary() {
        let mut cursor = ChannelCursor::default();
        assert!(
            is_strictly_older(999, "zzzz", &cursor),
            "with no boundary yet, the head page keeps everything"
        );

        cursor.advance_backfill(100, "bbbb");
        assert!(is_strictly_older(99, "zzzz", &cursor));
        assert!(!is_strictly_older(101, "aaaa", &cursor));
        // The boundary event itself comes back on the next inclusive `until`.
        assert!(!is_strictly_older(100, "bbbb", &cursor));
        // Same second, larger id: strictly older under `created_at DESC, id ASC`.
        assert!(is_strictly_older(100, "cccc", &cursor));
        assert!(!is_strictly_older(100, "aaaa", &cursor));
    }
}
