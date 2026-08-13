//! The search agent's query surface: a loopback HTTP endpoint (buzz#20).
//!
//! ## Why HTTP, and why only for now
//!
//! The agent lives on TOON, so the *right* long-run answer is that a desktop
//! client asks it the same way it asks anything else on the network: a paid
//! request event, an answer event. That is a workflow-runner shape and it
//! belongs to phase 5 — building it here would mean inventing a
//! request/response protocol, a pricing story, and a reply-routing story in a
//! ticket about indexing. So v1 is deliberately the smallest honest thing: a
//! localhost endpoint the desktop hits when it is configured with the agent's
//! URL (`BUZZ_SEARCH_AGENT_URL`).
//!
//! ## The trust gap, stated plainly
//!
//! **There is no authentication on this endpoint, and the scope is the
//! caller's word.** A request names the channels it wants searched, and the
//! agent searches exactly those and no others. It does not — cannot, today —
//! verify that the caller holds keys for them. What keeps that honest in v1:
//!
//! - The listener is **refused unless it is loopback** ([`assert_loopback`]),
//!   so the surface is other processes on this machine, not the network. An
//!   operator who wants it exposed has to put a real proxy in front and own
//!   that decision.
//! - Scope is **required and fail-closed**: an empty channel list returns zero
//!   hits, never everything ([`crate::search_index::SearchIndex::search`]).
//!   A caller cannot fish by omitting the argument.
//! - The desktop only ever asks for channels it holds keys for, so in the
//!   intended deployment the two membership sets already agree.
//!
//! That is a *local trusted agent* model: the agent trusts every process
//! running as the same user on the same machine, exactly as the sidecar and
//! the keystore already do. It is not a multi-user authorization story, and it
//! must not be deployed as one. The follow-up — a NIP-98-style signed request
//! whose signer must appear on the channel's validated admin/member list, or
//! the paid request/response pair that makes the question itself a TOON event
//! — is filed on the PR.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::error::CliError;
use crate::search_index::{SearchFilters, SearchIndex};

/// Hard ceiling on `limit`, so one query cannot ask the agent to serialize its
/// whole corpus. Matches the relay bridge's `min(100)` cap.
const MAX_LIMIT: usize = 100;
const DEFAULT_LIMIT: usize = 20;

/// `kind:9` — every message this agent indexes is a channel message, and the
/// desktop's `SearchHit` carries the kind, so it is echoed rather than guessed
/// at the other end.
const KIND_CHANNEL_MESSAGE: u16 = 9;

/// A query, in either of the two shapes the endpoint accepts: a `POST` body,
/// or `GET` parameters with `channels` as a comma-separated list (which is
/// what makes the endpoint usable from `curl` without a heredoc).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchAgentQuery {
    #[serde(default)]
    pub q: String,
    /// Channels the caller claims membership of. Required — see the module
    /// docs. Accepts a JSON array (POST) or a comma-separated string (GET).
    #[serde(default, deserialize_with = "channel_list")]
    pub channels: Vec<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Accept `["a","b"]`, `"a,b"`, or absent. One deserializer rather than two
/// request types, because the two spellings are the same question.
fn channel_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(raw)) => raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    })
}

impl SearchAgentQuery {
    /// Build a query from `GET` parameters: `channels` is a comma-separated
    /// list, `limit` a decimal, and anything unparseable falls back to the
    /// default rather than 400-ing — a bad `limit` should not look like an
    /// empty index.
    pub fn from_params(params: &HashMap<String, String>) -> Self {
        Self {
            q: params.get("q").cloned().unwrap_or_default(),
            channels: params
                .get("channels")
                .map(|raw| {
                    raw.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            limit: params.get("limit").and_then(|raw| raw.parse().ok()),
        }
    }
}

/// Answer one query against `index`.
///
/// Pure given the index, and shaped to the desktop's `SearchHit` type
/// (`desktop/src/shared/api/searchTypes.ts`) so the TS client is a `fetch` and
/// a cast rather than a mapping layer. `channelName` is `null` for the same
/// reason the relay bridge leaves it null: the agent indexes messages, and the
/// name lives in a channel event the caller already has.
pub fn search_response(index: &SearchIndex, query: &SearchAgentQuery) -> Value {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let hits = index.search(&query.q, &query.channels, &SearchFilters::default(), limit);
    let rows: Vec<Value> = hits
        .iter()
        .map(|hit| {
            json!({
                "eventId": hit.message.event_id,
                "content": hit.message.content,
                "kind": KIND_CHANNEL_MESSAGE,
                "pubkey": hit.message.pubkey,
                "channelId": hit.message.channel_id,
                "channelName": Value::Null,
                "createdAt": hit.message.created_at,
                "score": hit.score,
            })
        })
        .collect();
    json!({ "hits": rows, "found": rows.len() })
}

type Shared = Arc<RwLock<SearchIndex>>;

/// `GET /search?q=…&channels=a,b&limit=20`.
///
/// Deserialized from a flat string map rather than straight into
/// [`SearchAgentQuery`]: a query string has no arrays, and going through
/// `serde_urlencoded`'s untyped path to reach the array/CSV deserializer below
/// works by accident more than by contract. [`SearchAgentQuery::from_params`]
/// says what the mapping is.
async fn handle_get(
    State(index): State<Shared>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let query = SearchAgentQuery::from_params(&params);
    Json(search_response(&*index.read().await, &query))
}

async fn handle_post(
    State(index): State<Shared>,
    Json(query): Json<SearchAgentQuery>,
) -> Json<Value> {
    Json(search_response(&*index.read().await, &query))
}

/// Liveness plus enough state to tell "the agent is up but has indexed
/// nothing" from "the agent is down", which are the two things an operator
/// actually needs to distinguish. Channel *ids* only — never content.
async fn handle_health(State(index): State<Shared>) -> Json<Value> {
    let index = index.read().await;
    Json(json!({
        "ok": true,
        "documents": index.document_count(),
        "channels": index.channels().into_iter().collect::<Vec<_>>(),
    }))
}

/// Refuse to bind anywhere but the loopback interface.
///
/// This endpoint serves decrypted private-channel text with no authentication
/// (see the module docs). Binding it to `0.0.0.0` would publish every private
/// channel the agent is a member of to the local network, and it is exactly
/// the kind of mistake that is a one-character flag away — so it is an error
/// here rather than a warning in a README.
pub fn assert_loopback(addr: &SocketAddr) -> Result<(), CliError> {
    if addr.ip().is_loopback() {
        return Ok(());
    }
    Err(CliError::Usage(format!(
        "refusing to bind the search agent's query endpoint to {addr}: it serves decrypted \
private-channel messages and has no authentication, so it may only listen on loopback \
(127.0.0.1 or ::1). Put a proxy in front of it if you really mean to expose it."
    )))
}

/// Bind the query endpoint and serve it in the background.
///
/// Returns the address actually bound, so a caller that asked for port 0 —
/// every test — learns where to talk.
pub async fn serve(addr: SocketAddr, index: Shared) -> Result<SocketAddr, CliError> {
    assert_loopback(&addr)?;
    let app = Router::new()
        .route("/health", get(handle_health))
        .route("/search", get(handle_get).post(handle_post))
        .with_state(index);

    let listener = TcpListener::bind(addr).await.map_err(|e| {
        CliError::Other(format!(
            "could not bind the search agent's query endpoint to {addr}: {e}"
        ))
    })?;
    let bound = listener
        .local_addr()
        .map_err(|e| CliError::Other(format!("could not read the bound address: {e}")))?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(bound)
}

#[cfg(test)]
mod tests {
    use crate::search_index::IndexedMessage;

    use super::*;

    fn index_with(messages: &[(&str, &str, &str)]) -> SearchIndex {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SearchIndex::open(dir.path().join("search-index.json"));
        for (id, channel, content) in messages {
            index.insert(IndexedMessage {
                event_id: (*id).to_string(),
                channel_id: (*channel).to_string(),
                pubkey: "ab".repeat(32),
                created_at: 1_700_000_000,
                content: (*content).to_string(),
                key_id: None,
            });
        }
        // The TempDir is dropped here; nothing below touches the filesystem.
        index
    }

    fn query(q: &str, channels: &[&str]) -> SearchAgentQuery {
        SearchAgentQuery {
            q: q.to_string(),
            channels: channels.iter().map(|c| (*c).to_string()).collect(),
            limit: None,
        }
    }

    #[test]
    fn a_hit_carries_the_fields_the_desktop_search_hit_type_needs() {
        let index = index_with(&[("e1", "engineering", "the deploy token is in the vault")]);
        let out = search_response(&index, &query("deploy", &["engineering"]));

        assert_eq!(out["found"], 1);
        let hit = &out["hits"][0];
        assert_eq!(hit["eventId"], "e1");
        assert_eq!(hit["channelId"], "engineering");
        assert_eq!(hit["kind"], 9);
        assert_eq!(hit["channelName"], Value::Null);
        assert_eq!(hit["createdAt"], 1_700_000_000u64);
        assert_eq!(hit["content"], "the deploy token is in the vault");
        assert!(hit["score"].as_f64().unwrap() > 0.0);
    }

    /// The acceptance criterion at the query surface: scope is required, and
    /// asking for nothing gets nothing.
    #[test]
    fn a_query_with_no_channel_scope_returns_nothing() {
        let index = index_with(&[("e1", "engineering", "the deploy token")]);
        let out = search_response(&index, &query("deploy", &[]));
        assert_eq!(out["found"], 0);
        assert_eq!(out["hits"], json!([]));
    }

    #[test]
    fn a_query_cannot_reach_a_channel_it_did_not_name() {
        let index = index_with(&[
            ("e1", "engineering", "the deploy token"),
            ("c1", "control", "the deploy token"),
        ]);
        let out = search_response(&index, &query("deploy", &["engineering"]));
        assert_eq!(out["found"], 1);
        assert_eq!(out["hits"][0]["eventId"], "e1");
    }

    #[test]
    fn the_limit_is_capped_and_defaulted() {
        let messages: Vec<(String, String, String)> = (0..150)
            .map(|n| {
                (
                    format!("e{n}"),
                    "eng".to_string(),
                    "deploy token".to_string(),
                )
            })
            .collect();
        let borrowed: Vec<(&str, &str, &str)> = messages
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
            .collect();
        let index = index_with(&borrowed);

        let defaulted = search_response(&index, &query("deploy", &["eng"]));
        assert_eq!(defaulted["found"], DEFAULT_LIMIT);

        let mut greedy = query("deploy", &["eng"]);
        greedy.limit = Some(10_000);
        assert_eq!(search_response(&index, &greedy)["found"], MAX_LIMIT);
    }

    #[test]
    fn channels_parse_from_both_a_json_array_and_a_comma_list() {
        let from_array: SearchAgentQuery =
            serde_json::from_value(json!({"q": "x", "channels": ["a", " b ", ""]})).unwrap();
        assert_eq!(from_array.channels, vec!["a", "b"]);

        let from_csv: SearchAgentQuery =
            serde_json::from_value(json!({"q": "x", "channels": "a, b,"})).unwrap();
        assert_eq!(from_csv.channels, vec!["a", "b"]);

        let absent: SearchAgentQuery = serde_json::from_value(json!({"q": "x"})).unwrap();
        assert!(absent.channels.is_empty());
    }

    /// The endpoint has no auth, so the bind address is the whole perimeter.
    #[test]
    fn binding_off_loopback_is_refused() {
        assert!(assert_loopback(&"127.0.0.1:8788".parse().unwrap()).is_ok());
        assert!(assert_loopback(&"[::1]:8788".parse().unwrap()).is_ok());

        let err = assert_loopback(&"0.0.0.0:8788".parse().unwrap()).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
        assert!(assert_loopback(&"192.168.1.10:8788".parse().unwrap()).is_err());
    }
}
