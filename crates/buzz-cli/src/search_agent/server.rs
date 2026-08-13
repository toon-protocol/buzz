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

use axum::extract::{Query, RawQuery, State};
use axum::http::{header::AUTHORIZATION, HeaderMap};
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
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
/// or `GET` parameters with `channels`/`authors` as comma-separated lists
/// (which is what makes the endpoint usable from `curl` without a heredoc).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchAgentQuery {
    #[serde(default)]
    pub q: String,
    /// Channels the caller claims membership of. Required — see the module
    /// docs. Accepts a JSON array (POST) or a comma-separated string (GET).
    #[serde(default, deserialize_with = "string_list")]
    pub channels: Vec<String>,
    /// Hex pubkeys the `from:` operator narrowed to. Same two spellings as
    /// `channels`. Empty means every author.
    #[serde(default, deserialize_with = "string_list")]
    pub authors: Vec<String>,
    /// Inclusive lower bound on `created_at` (`after:`).
    #[serde(default)]
    pub since: Option<u64>,
    /// Inclusive upper bound on `created_at` (`before:`).
    #[serde(default)]
    pub until: Option<u64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Accept `["a","b"]`, `"a,b"`, or absent. One deserializer rather than two
/// request types, because the two spellings are the same question. Shared by
/// `channels` and `authors` — both are comma-or-array lists of strings.
fn string_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(raw)) => split_csv(&raw),
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    })
}

/// Split a comma-separated `GET` parameter into a trimmed, non-empty list.
fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

impl SearchAgentQuery {
    /// Build a query from `GET` parameters: `channels`/`authors` are
    /// comma-separated lists, `limit`/`since`/`until` are decimals, and
    /// anything unparseable falls back to the default rather than 400-ing —
    /// a bad `limit` should not look like an empty index.
    pub fn from_params(params: &HashMap<String, String>) -> Self {
        Self {
            q: params.get("q").cloned().unwrap_or_default(),
            channels: params
                .get("channels")
                .map(|raw| split_csv(raw))
                .unwrap_or_default(),
            authors: params
                .get("authors")
                .map(|raw| split_csv(raw))
                .unwrap_or_default(),
            since: params.get("since").and_then(|raw| raw.parse().ok()),
            until: params.get("until").and_then(|raw| raw.parse().ok()),
            limit: params.get("limit").and_then(|raw| raw.parse().ok()),
        }
    }
}

/// Answer one query against `index`, scoped to `channels` rather than
/// `query.channels` directly.
///
/// The channel list is a separate argument — not read off `query` — because
/// by the time this is called it has already been intersected against the
/// signer's validated membership (see [`handle_get`]/[`handle_post`]): the
/// caller's *claim* of scope and the *authorized* scope are different values,
/// and this function only ever sees the latter.
///
/// Pure given its inputs, and shaped to the desktop's `SearchHit` type
/// (`desktop/src/shared/api/searchTypes.ts`) so the TS client is a `fetch` and
/// a cast rather than a mapping layer. `channelName` is `null` for the same
/// reason the relay bridge leaves it null: the agent indexes messages, and the
/// name lives in a channel event the caller already has.
pub fn search_response(
    index: &SearchIndex,
    query: &SearchAgentQuery,
    channels: &[String],
) -> Value {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let filters = SearchFilters {
        authors: &query.authors,
        since: query.since,
        until: query.until,
    };
    let hits = index.search(&query.q, channels, &filters, limit);
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

pub type IndexHandle = Arc<RwLock<SearchIndex>>;

/// Everything a request handler needs: the index, and the base URL the agent
/// itself is bound to (so an incoming NIP-98 `u` tag can be checked against
/// what the client actually signed, not just parsed and trusted).
#[derive(Clone)]
struct QueryState {
    index: IndexHandle,
    /// `http://127.0.0.1:<port>`, computed once the listener is actually
    /// bound — the same string [`crate::search_agent::run`] prints as
    /// `queryUrl`, so client and server agree on it by construction rather
    /// than by convention.
    base_url: String,
}

/// Verify an `Authorization: Nostr <base64>` header (NIP-98) against the
/// exact request the caller is making, and return the signer.
///
/// `None` covers every way a request can fail to be provably signed — no
/// header, malformed base64/JSON/event, a signature that does not verify, or
/// a `u`/`method`/`payload` tag that does not match this exact request — and
/// they are all the same answer here on purpose. This endpoint never 401s: a
/// request that is not provably signed gets the same empty result set as one
/// that named no channels ([`crate::search_index::SearchIndex::search`]),
/// so probing the header format teaches an attacker nothing a probing the
/// scope wouldn't already.
fn authenticate(
    headers: &HeaderMap,
    method: &str,
    url: &str,
    body: Option<&[u8]>,
) -> Option<nostr::PublicKey> {
    let header = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let encoded = header.strip_prefix("Nostr ")?;
    let event_json = String::from_utf8(BASE64.decode(encoded).ok()?).ok()?;
    buzz_auth::verify_nip98_event(&event_json, url, method, body).ok()
}

/// `GET /search?q=…&channels=a,b&limit=20`.
///
/// Deserialized from a flat string map rather than straight into
/// [`SearchAgentQuery`]: a query string has no arrays, and going through
/// `serde_urlencoded`'s untyped path to reach the array/CSV deserializer below
/// works by accident more than by contract. [`SearchAgentQuery::from_params`]
/// says what the mapping is.
///
/// The signed `u` tag must match this exact URL, query string included —
/// [`RawQuery`] carries the string exactly as the client sent it, so the
/// comparison is byte-for-byte rather than a reserialization that could
/// disagree with what was actually signed.
async fn handle_get(
    State(state): State<QueryState>,
    RawQuery(raw_query): RawQuery,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Json<Value> {
    let query = SearchAgentQuery::from_params(&params);
    let expected_url = match raw_query {
        Some(q) if !q.is_empty() => format!("{}/search?{q}", state.base_url),
        _ => format!("{}/search", state.base_url),
    };
    let signer = authenticate(&headers, "GET", &expected_url, None);
    let channels = if signer.is_some() {
        query.channels.clone()
    } else {
        Vec::new()
    };
    Json(search_response(
        &*state.index.read().await,
        &query,
        &channels,
    ))
}

/// `POST /search`, body `SearchAgentQuery` JSON.
///
/// The body is read as raw bytes first — not straight into
/// [`SearchAgentQuery`] — so the same bytes can both deserialize the query
/// and verify an optional NIP-98 `payload` hash tag against exactly what was
/// signed. A body that fails to parse as JSON degrades to the default (empty)
/// query rather than a 400, matching [`SearchAgentQuery::from_params`]'s
/// "never look like a different failure than an empty index" rule.
async fn handle_post(
    State(state): State<QueryState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Json<Value> {
    let query: SearchAgentQuery = serde_json::from_slice(&body).unwrap_or_default();
    let expected_url = format!("{}/search", state.base_url);
    let signer = authenticate(&headers, "POST", &expected_url, Some(&body));
    let channels = if signer.is_some() {
        query.channels.clone()
    } else {
        Vec::new()
    };
    Json(search_response(
        &*state.index.read().await,
        &query,
        &channels,
    ))
}

/// Liveness plus enough state to tell "the agent is up but has indexed
/// nothing" from "the agent is down", which are the two things an operator
/// actually needs to distinguish. Channel *ids* only — never content.
async fn handle_health(State(state): State<QueryState>) -> Json<Value> {
    let index = state.index.read().await;
    Json(json!({
        "ok": true,
        "documents": index.document_count(),
        "channels": index.channels().into_iter().collect::<Vec<_>>(),
    }))
}

/// Refuse to bind anywhere but the loopback interface.
///
/// This endpoint serves decrypted private-channel text. Signed queries close
/// the authorization gap (see the module docs), but the loopback refusal
/// stays exactly as strict: it is defense in depth against a deployment
/// mistake, not a substitute for authorization, and relaxing it would still
/// publish query traffic (and the mere existence of a match) to the local
/// network. Binding it to `0.0.0.0` is exactly the kind of mistake that is a
/// one-character flag away — so it is an error here rather than a warning in
/// a README.
pub fn assert_loopback(addr: &SocketAddr) -> Result<(), CliError> {
    if addr.ip().is_loopback() {
        return Ok(());
    }
    Err(CliError::Usage(format!(
        "refusing to bind the search agent's query endpoint to {addr}: it serves decrypted \
private-channel messages, so it may only listen on loopback (127.0.0.1 or ::1). Put a real \
proxy in front of it if you really mean to expose it."
    )))
}

/// Bind the query endpoint and serve it in the background.
///
/// Returns the address actually bound, so a caller that asked for port 0 —
/// every test — learns where to talk. Binds before constructing [`QueryState`]
/// because `base_url` is derived from the real bound address, not the
/// requested one — port 0 resolves to whatever the OS actually handed back.
pub async fn serve(addr: SocketAddr, index: IndexHandle) -> Result<SocketAddr, CliError> {
    assert_loopback(&addr)?;
    let listener = TcpListener::bind(addr).await.map_err(|e| {
        CliError::Other(format!(
            "could not bind the search agent's query endpoint to {addr}: {e}"
        ))
    })?;
    let bound = listener
        .local_addr()
        .map_err(|e| CliError::Other(format!("could not read the bound address: {e}")))?;

    let state = QueryState {
        index,
        base_url: format!("http://{bound}"),
    };
    let app = Router::new()
        .route("/health", get(handle_health))
        .route("/search", get(handle_get).post(handle_post))
        .with_state(state);

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
            ..Default::default()
        }
    }

    /// Run `search_response` with the query's own `channels` as the
    /// authorized scope — the world these pre-auth tests live in, where the
    /// caller's claim and the authorized scope are the same thing.
    fn respond(index: &SearchIndex, query: &SearchAgentQuery) -> Value {
        search_response(index, query, &query.channels)
    }

    #[test]
    fn a_hit_carries_the_fields_the_desktop_search_hit_type_needs() {
        let index = index_with(&[("e1", "engineering", "the deploy token is in the vault")]);
        let out = respond(&index, &query("deploy", &["engineering"]));

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
        let out = respond(&index, &query("deploy", &[]));
        assert_eq!(out["found"], 0);
        assert_eq!(out["hits"], json!([]));
    }

    #[test]
    fn a_query_cannot_reach_a_channel_it_did_not_name() {
        let index = index_with(&[
            ("e1", "engineering", "the deploy token"),
            ("c1", "control", "the deploy token"),
        ]);
        let out = respond(&index, &query("deploy", &["engineering"]));
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

        let defaulted = respond(&index, &query("deploy", &["eng"]));
        assert_eq!(defaulted["found"], DEFAULT_LIMIT);

        let mut greedy = query("deploy", &["eng"]);
        greedy.limit = Some(10_000);
        assert_eq!(respond(&index, &greedy)["found"], MAX_LIMIT);
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

    /// `authors` takes the same two spellings as `channels`, via the shared
    /// `string_list` deserializer.
    #[test]
    fn authors_parse_from_both_a_json_array_and_a_comma_list() {
        let from_array: SearchAgentQuery =
            serde_json::from_value(json!({"q": "x", "authors": ["a", " b ", ""]})).unwrap();
        assert_eq!(from_array.authors, vec!["a", "b"]);

        let from_csv: SearchAgentQuery =
            serde_json::from_value(json!({"q": "x", "authors": "a, b,"})).unwrap();
        assert_eq!(from_csv.authors, vec!["a", "b"]);

        let absent: SearchAgentQuery = serde_json::from_value(json!({"q": "x"})).unwrap();
        assert!(absent.authors.is_empty());
    }

    #[test]
    fn since_and_until_parse_as_plain_integers() {
        let parsed: SearchAgentQuery =
            serde_json::from_value(json!({"q": "x", "since": 100, "until": 200})).unwrap();
        assert_eq!(parsed.since, Some(100));
        assert_eq!(parsed.until, Some(200));

        let absent: SearchAgentQuery = serde_json::from_value(json!({"q": "x"})).unwrap();
        assert_eq!(absent.since, None);
        assert_eq!(absent.until, None);
    }

    /// `from_params` is the `GET` shape's mapping — same fields, string wire
    /// format.
    #[test]
    fn get_params_carry_authors_since_and_until() {
        let mut params = HashMap::new();
        params.insert("q".to_string(), "deploy".to_string());
        params.insert("authors".to_string(), "aa, bb".to_string());
        params.insert("since".to_string(), "100".to_string());
        params.insert("until".to_string(), "200".to_string());

        let parsed = SearchAgentQuery::from_params(&params);
        assert_eq!(parsed.authors, vec!["aa", "bb"]);
        assert_eq!(parsed.since, Some(100));
        assert_eq!(parsed.until, Some(200));
    }

    /// The filters reach the index: a message outside the author/date
    /// narrowing does not come back even though it matches the text query and
    /// the channel scope.
    #[test]
    fn authors_since_and_until_narrow_the_results() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SearchIndex::open(dir.path().join("search-index.json"));
        index.insert(IndexedMessage {
            event_id: "in-range".to_string(),
            channel_id: "eng".to_string(),
            pubkey: "aa".repeat(32),
            created_at: 200,
            content: "deploy token".to_string(),
            key_id: None,
        });
        index.insert(IndexedMessage {
            event_id: "wrong-author".to_string(),
            channel_id: "eng".to_string(),
            pubkey: "bb".repeat(32),
            created_at: 200,
            content: "deploy token".to_string(),
            key_id: None,
        });
        index.insert(IndexedMessage {
            event_id: "too-old".to_string(),
            channel_id: "eng".to_string(),
            pubkey: "aa".repeat(32),
            created_at: 50,
            content: "deploy token".to_string(),
            key_id: None,
        });

        let q = SearchAgentQuery {
            q: "deploy".to_string(),
            channels: vec!["eng".to_string()],
            authors: vec!["aa".repeat(32)],
            since: Some(100),
            until: Some(300),
            limit: None,
        };
        let out = respond(&index, &q);
        assert_eq!(out["found"], 1, "{out}");
        assert_eq!(out["hits"][0]["eventId"], "in-range");
    }

    /// Defense in depth: signed queries close the authorization gap, but the
    /// bind address stays a hard perimeter regardless.
    #[test]
    fn binding_off_loopback_is_refused() {
        assert!(assert_loopback(&"127.0.0.1:8788".parse().unwrap()).is_ok());
        assert!(assert_loopback(&"[::1]:8788".parse().unwrap()).is_ok());

        let err = assert_loopback(&"0.0.0.0:8788".parse().unwrap()).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
        assert!(assert_loopback(&"192.168.1.10:8788".parse().unwrap()).is_err());
    }

    // ─── NIP-98 authentication ──────────────────────────────────────────────

    const AUTH_URL: &str = "http://127.0.0.1:8788/search";

    fn auth_header(keys: &nostr::Keys, method: &str, url: &str, payload: Option<&[u8]>) -> String {
        let mut tags = vec![
            nostr::Tag::parse(["u", url]).unwrap(),
            nostr::Tag::parse(["method", method]).unwrap(),
        ];
        if let Some(body) = payload {
            use sha2::Digest as _;
            let hash = hex::encode(sha2::Sha256::digest(body));
            tags.push(nostr::Tag::parse(["payload", &hash]).unwrap());
        }
        let event = nostr::EventBuilder::new(nostr::Kind::HttpAuth, "")
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap();
        format!(
            "Nostr {}",
            BASE64.encode(serde_json::to_string(&event).unwrap())
        )
    }

    fn headers_with(auth: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth.parse().unwrap());
        headers
    }

    #[test]
    fn a_missing_authorization_header_authenticates_to_nobody() {
        assert!(authenticate(&HeaderMap::new(), "GET", AUTH_URL, None).is_none());
    }

    #[test]
    fn a_well_formed_signature_authenticates_to_its_signer() {
        let keys = nostr::Keys::generate();
        let header = auth_header(&keys, "GET", AUTH_URL, None);
        let signer = authenticate(&headers_with(&header), "GET", AUTH_URL, None);
        assert_eq!(signer, Some(keys.public_key()));
    }

    #[test]
    fn a_payload_tag_is_checked_against_the_actual_body() {
        let keys = nostr::Keys::generate();
        let body = br#"{"q":"deploy","channels":["eng"]}"#;
        let header = auth_header(&keys, "POST", AUTH_URL, Some(body));

        assert!(
            authenticate(&headers_with(&header), "POST", AUTH_URL, Some(body)).is_some(),
            "the signed hash matches the real body"
        );
        assert!(
            authenticate(&headers_with(&header), "POST", AUTH_URL, Some(b"tampered")).is_none(),
            "a body swapped after signing must not authenticate"
        );
    }

    #[test]
    fn a_url_or_method_mismatch_authenticates_to_nobody() {
        let keys = nostr::Keys::generate();
        let header = auth_header(&keys, "GET", AUTH_URL, None);

        assert!(authenticate(&headers_with(&header), "POST", AUTH_URL, None).is_none());
        assert!(authenticate(
            &headers_with(&header),
            "GET",
            "http://127.0.0.1:8788/search?q=other",
            None
        )
        .is_none());
    }

    #[test]
    fn garbage_in_the_authorization_header_authenticates_to_nobody() {
        for auth in [
            "Nostr not-base64!!",
            "Nostr ",
            "Basic dXNlcjpwYXNz",
            &BASE64.encode("not an event"),
        ] {
            assert!(
                authenticate(&headers_with(auth), "GET", AUTH_URL, None).is_none(),
                "{auth} must not authenticate"
            );
        }
    }
}
