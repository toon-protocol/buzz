//! TOON payment transport for the buzz-acp harness (buzz#73).
//!
//! ## Payment-path topology
//!
//! This module reaches a `toon-clientd` sidecar over HTTP — the exact
//! pattern `buzz-cli`'s `buzz toon` subcommand tree and its two existing
//! agent-members (search indexer, workflow runner) already use (see
//! `buzz-cli/src/sidecar.rs`). The sidecar is the identity custodian: it
//! holds the agent's derived-from-seed nostr key, its wallet, and its
//! payment channel. This harness never sees a mnemonic or a private key for
//! the TOON identity — it hands the sidecar an unsigned event shell (kind,
//! content, tags) and the sidecar signs and pays for it from the agent's own
//! channel.
//!
//! **Decision this ticket owns (buzz#73, blocking buzz#79's fleet
//! decomposition): one `toon-clientd` daemon per agent**, addressed by URL
//! (`--sidecar-url` / `TOON_DAEMON_URL`), never a shared multi-identity
//! daemon and never an in-process payment client. Two things force this:
//!
//! 1. There is no embeddable Rust TOON/ILP payment client anywhere in this
//!    stack (confirmed by grep across every `Cargo.toml` in the workspace,
//!    and by the desktop Rust `EventTransport`'s own `BridgeTransport` doc
//!    comment, which bridges to a *live webview* for exactly this reason —
//!    a bridge that does not exist for a headless harness). An in-process
//!    client is not on the table until one is built.
//! 2. `toon-clientd` has no multi-identity mode — its `/status` response
//!    carries exactly one `identity`. A single daemon fronting N agents
//!    would need to multiplex identities inside the daemon, which is new
//!    daemon-side work with no precedent here.
//!
//! So "daemon per agent" is not a preference among equals — it is the only
//! option that requires zero new payment-client engineering, and it is
//! already proven by `search_agent`/`workflow_agent` in `buzz-cli`. buzz#79
//! is expected to spawn N of these pairs (one `toon-clientd` + one
//! `buzz-acp`, or one `toon-clientd` + N `buzz-acp` *subprocess workers of
//! the same agent identity*, since `--agents` already means parallel workers
//! of one identity, not N personas) rather than revisit this shape.
//!
//! ## The transport seam
//!
//! Mirrors the shape of desktop's Rust `EventTransport`
//! (`desktop/src-tauri/src/event_transport/mod.rs`, buzz#27): one dispatch
//! point, keyed off configured mode, so a write never hard-wires a second
//! ad-hoc publish path. [`EventTransport::publish`] is that single point for
//! callers that adopt it — see [`crate::pool::post_failure_notice`] for the
//! first caller ported over.

use nostr::{EventBuilder, Keys};
use serde::{Deserialize, Serialize};

use crate::relay::{RelayError, RestClient};

/// Default `toon-clientd` control-API URL — matches `buzz-cli`'s
/// `--sidecar-url` / `TOON_DAEMON_URL` default so an operator running both
/// against the same daemon needs no extra configuration.
pub const DEFAULT_SIDECAR_URL: &str = "http://127.0.0.1:8787";

/// Which path a write takes: the classic signed-event relay, or the paid
/// TOON sidecar. Selected by `BUZZ_TRANSPORT` (`relay` default, `toon` to
/// opt in) — same env var and same two values as the desktop TS/Rust seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
#[value(rename_all = "lower")]
pub enum TransportMode {
    #[default]
    Relay,
    Toon,
}

/// Errors talking to the `toon-clientd` control API.
#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    /// Connection-level failure — distinguished from a slow or malformed
    /// response so "the daemon isn't running" never looks like a payment
    /// rejection.
    #[error("toon-clientd sidecar unreachable at {url}: {detail}")]
    Unreachable { url: String, detail: String },

    /// The daemon's own `{error, detail, retryable}` envelope, surfaced
    /// verbatim (insufficient channel balance, still bootstrapping, etc.).
    #[error(
        "toon-clientd sidecar rejected the request (HTTP {status}): {error}{}",
        detail.as_deref().map(|d| format!(" — {d}")).unwrap_or_default()
    )]
    Rejected {
        status: u16,
        error: String,
        detail: Option<String>,
        retryable: bool,
    },

    #[error("malformed sidecar response: {0}")]
    Malformed(String),
}

impl SidecarError {
    /// Whether the caller can reasonably retry. A dead daemon might come
    /// back up; the daemon's own `retryable` flag is trusted otherwise.
    pub fn is_retryable(&self) -> bool {
        match self {
            SidecarError::Unreachable { .. } => true,
            SidecarError::Rejected { retryable, .. } => *retryable,
            SidecarError::Malformed(_) => false,
        }
    }
}

/// `GET /status` response — the fields this harness reads. Mirrors
/// `buzz-cli::sidecar::SidecarStatus`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarStatus {
    /// True once the client has started and a channel is open — resumed
    /// from a prior run, or freshly opened on first run.
    pub ready: bool,
    #[serde(default)]
    pub bootstrapping: bool,
    pub identity: SidecarIdentity,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarIdentity {
    #[serde(rename = "nostrPubkey")]
    pub nostr_pubkey: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct PublishUnsignedRequest {
    kind: u16,
    content: String,
    tags: Vec<Vec<String>>,
}

/// `POST /publish-unsigned` response — a paid-write receipt. Mirrors
/// `buzz-cli::sidecar::PublishReceipt`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishReceipt {
    #[serde(rename = "eventId")]
    pub event_id: String,
    /// Channel the claim was signed against — the agent's own, never the
    /// owner's.
    #[serde(rename = "channelId")]
    pub channel_id: String,
    /// Channel nonce after this publish — the claim watermark.
    pub nonce: u64,
    #[serde(rename = "feePaid")]
    pub fee_paid: String,
    #[serde(rename = "channelBalanceAfter", default)]
    pub channel_balance_after: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: String,
    detail: Option<String>,
    #[serde(default)]
    retryable: bool,
}

/// Thin HTTP client for the local `toon-clientd` control API. See the module
/// doc for why this — not an in-process payment client — is the seam.
#[derive(Clone)]
pub struct SidecarClient {
    http: reqwest::Client,
    base_url: String,
}

impl SidecarClient {
    pub fn new(base_url: impl Into<String>) -> Result<Self, SidecarError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(40))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| SidecarError::Malformed(format!("failed to build HTTP client: {e}")))?;
        Ok(Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        })
    }

    /// `GET /status` — daemon + channel readiness.
    pub async fn status(&self) -> Result<SidecarStatus, SidecarError> {
        let url = format!("{}/status", self.base_url);
        let resp = self.send(self.http.get(&url), &url).await?;
        Self::parse_ok(resp).await
    }

    /// `POST /publish-unsigned` — the daemon builds, signs (with its own
    /// held key), and pays for the event from the agent's own channel. The
    /// caller supplies only the event shell.
    pub async fn publish_unsigned(
        &self,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
    ) -> Result<PublishReceipt, SidecarError> {
        let url = format!("{}/publish-unsigned", self.base_url);
        let body = PublishUnsignedRequest {
            kind,
            content,
            tags,
        };
        let resp = self.send(self.http.post(&url).json(&body), &url).await?;
        Self::parse_ok(resp).await
    }

    async fn send(
        &self,
        req: reqwest::RequestBuilder,
        url: &str,
    ) -> Result<reqwest::Response, SidecarError> {
        req.send().await.map_err(|e| {
            if e.is_connect() {
                SidecarError::Unreachable {
                    url: url.to_string(),
                    detail: e.to_string(),
                }
            } else {
                SidecarError::Malformed(e.to_string())
            }
        })
    }

    async fn parse_ok<T: serde::de::DeserializeOwned>(
        resp: reqwest::Response,
    ) -> Result<T, SidecarError> {
        let status = resp.status();
        if status.is_success() {
            return resp
                .json::<T>()
                .await
                .map_err(|e| SidecarError::Malformed(format!("malformed sidecar response: {e}")));
        }
        let body = resp.text().await.unwrap_or_default();
        let envelope: ErrorEnvelope = serde_json::from_str(&body).unwrap_or(ErrorEnvelope {
            error: "unknown".to_string(),
            detail: if body.is_empty() { None } else { Some(body) },
            retryable: matches!(status.as_u16(), 429 | 502 | 503 | 504),
        });
        Err(SidecarError::Rejected {
            status: status.as_u16(),
            error: envelope.error,
            detail: envelope.detail,
            retryable: envelope.retryable,
        })
    }
}

/// Outcome of [`EventTransport::publish`] — enough for a caller to log a
/// fee or move on; never blocks on it.
#[derive(Debug, Clone)]
pub enum PublishOutcome {
    Relay,
    Toon {
        fee_paid: String,
        channel_id: String,
        nonce: u64,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error(transparent)]
    Relay(#[from] RelayError),
    #[error(transparent)]
    Sidecar(#[from] SidecarError),
    #[error("failed to build event: {0}")]
    Build(String),
}

/// The transport seam: one dispatch point for "how does this write reach
/// the network," keyed off [`TransportMode`]. See the module doc.
#[derive(Clone)]
pub enum EventTransport {
    /// Sign locally and submit via the classic relay HTTP bridge.
    Relay(RestClient),
    /// Hand an unsigned event shell to the agent's own `toon-clientd`
    /// sidecar, which signs and pays for it from the agent's own channel.
    Toon(SidecarClient),
}

impl EventTransport {
    /// Publish `builder` as `keys`' event. On [`EventTransport::Relay`],
    /// `keys` signs it locally. On [`EventTransport::Toon`], `keys` supplies
    /// only the placeholder pubkey `EventBuilder::build` needs to assemble
    /// the unsigned shell — the sidecar's own held key is the one that
    /// actually signs, since payer and signer are the same agent identity
    /// by construction of the "daemon per agent" topology (see module doc).
    pub async fn publish(
        &self,
        keys: &Keys,
        builder: EventBuilder,
    ) -> Result<PublishOutcome, TransportError> {
        match self {
            EventTransport::Relay(rest) => {
                let event = builder
                    .sign_with_keys(keys)
                    .map_err(|e| TransportError::Build(e.to_string()))?;
                rest.submit_event(&event).await?;
                Ok(PublishOutcome::Relay)
            }
            EventTransport::Toon(sidecar) => {
                let unsigned = builder.build(keys.public_key());
                let kind = unsigned.kind.as_u16();
                let tags = unsigned
                    .tags
                    .as_slice()
                    .iter()
                    .map(|t| t.as_slice().to_vec())
                    .collect();
                let receipt = sidecar
                    .publish_unsigned(kind, unsigned.content, tags)
                    .await?;
                Ok(PublishOutcome::Toon {
                    fee_paid: receipt.fee_paid,
                    channel_id: receipt.channel_id,
                    nonce: receipt.nonce,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{Response, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use tokio::net::TcpListener;

    use super::*;

    type Handler = Arc<dyn Fn(u32) -> (StatusCode, String) + Send + Sync>;

    async fn test_server<F>(f: F) -> (String, Arc<AtomicU32>)
    where
        F: Fn(u32) -> (StatusCode, String) + Send + Sync + 'static,
    {
        let counter = Arc::new(AtomicU32::new(0));
        let handler: Handler = Arc::new(f);
        let state = (handler, counter.clone());

        type S = (Handler, Arc<AtomicU32>);
        let respond = |State((handler, ctr)): State<S>| async move {
            let n = ctr.fetch_add(1, Ordering::SeqCst) + 1;
            let (status, body) = handler(n);
            Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap()
        };
        let app = Router::new()
            .route("/status", get(respond))
            .route("/publish-unsigned", post(respond))
            .with_state(state);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), counter)
    }

    #[tokio::test]
    async fn publish_unsigned_returns_receipt_with_fee_and_watermark() {
        let (url, _) = test_server(|_n| {
            (
                StatusCode::OK,
                r#"{
                    "eventId": "evt1",
                    "channelId": "agent-own-channel",
                    "nonce": 7,
                    "feePaid": "2000",
                    "channelBalanceAfter": "998000"
                }"#
                .to_string(),
            )
        })
        .await;
        let client = SidecarClient::new(url).unwrap();
        let receipt = client
            .publish_unsigned(9, "hello".to_string(), vec![vec!["h".into(), "c1".into()]])
            .await
            .unwrap();
        assert_eq!(receipt.event_id, "evt1");
        assert_eq!(receipt.channel_id, "agent-own-channel");
        assert_eq!(receipt.nonce, 7);
        assert_eq!(receipt.fee_paid, "2000");
    }

    #[tokio::test]
    async fn publish_unsigned_payment_failure_surfaces_rejected_error() {
        let (url, _) = test_server(|_n| {
            (
                StatusCode::BAD_GATEWAY,
                r#"{"error":"rejected","detail":"insufficient channel balance","retryable":false}"#
                    .to_string(),
            )
        })
        .await;
        let client = SidecarClient::new(url).unwrap();
        let err = client
            .publish_unsigned(9, "hello".to_string(), vec![])
            .await
            .unwrap_err();
        match err {
            SidecarError::Rejected {
                status,
                error,
                retryable,
                ..
            } => {
                assert_eq!(status, 502);
                assert_eq!(error, "rejected");
                assert!(!retryable);
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn sidecar_down_is_unreachable_not_a_payment_rejection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener); // nothing listens — connection refused

        let client = SidecarClient::new(format!("http://{addr}")).unwrap();
        let err = client.status().await.unwrap_err();
        assert!(matches!(err, SidecarError::Unreachable { .. }));
        assert!(err.is_retryable());
    }

    #[tokio::test]
    async fn event_transport_toon_dispatch_pays_from_agents_own_channel_and_keeps_signer() {
        let (url, attempts) = test_server(|_n| {
            (
                StatusCode::OK,
                r#"{
                    "eventId": "evt2",
                    "channelId": "agent-own-channel",
                    "nonce": 1,
                    "feePaid": "1000"
                }"#
                .to_string(),
            )
        })
        .await;
        let sidecar = SidecarClient::new(url).unwrap();
        let transport = EventTransport::Toon(sidecar);
        let keys = Keys::generate();

        let builder = EventBuilder::new(nostr::Kind::Custom(9), "paid reply")
            .tag(nostr::Tag::parse(["h", "11111111-1111-1111-1111-111111111111"]).unwrap());

        let outcome = transport.publish(&keys, builder).await.unwrap();
        match outcome {
            PublishOutcome::Toon {
                fee_paid,
                channel_id,
                nonce,
            } => {
                assert_eq!(fee_paid, "1000");
                assert_eq!(channel_id, "agent-own-channel");
                assert_eq!(nonce, 1);
            }
            other => panic!("expected Toon outcome, got {other:?}"),
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1, "single publish call");
    }

    #[tokio::test]
    async fn event_transport_relay_dispatch_signs_locally_and_submits() {
        let counter = Arc::new(AtomicU32::new(0));
        let ctr = counter.clone();
        let respond = move || {
            let ctr = ctr.clone();
            async move {
                ctr.fetch_add(1, Ordering::SeqCst);
                (StatusCode::OK, "{}".to_string())
            }
        };
        let app = Router::new().route("/events", post(respond));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let rest = RestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{addr}"),
            keys: Keys::generate(),
            auth_tag_json: None,
        };
        let transport = EventTransport::Relay(rest);
        let keys = Keys::generate();
        let builder = EventBuilder::new(nostr::Kind::Custom(9), "unpaid reply");

        let outcome = transport.publish(&keys, builder).await.unwrap();
        assert!(matches!(outcome, PublishOutcome::Relay));
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "relay dispatch must submit exactly once via POST /events"
        );
    }
}
