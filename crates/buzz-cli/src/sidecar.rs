use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// Thin HTTP client for the local `toon-clientd` control API.
///
/// This is deliberately NOT a second `ToonClient`: the sidecar owns the
/// agent's identity, channels, and payment claims, and this CLI never sees a
/// mnemonic or a private key. Every method here is one JSON request to a
/// `127.0.0.1`-bound daemon — mirroring `@toon-protocol/client-mcp`'s
/// `ControlClient`, which the MCP server uses to drive the same daemon.
///
/// See `packages/client-mcp/src/control-client.ts` and `control-api.ts` in
/// the `toon-client` repo for the canonical wire contract this mirrors.
pub struct SidecarClient {
    http: reqwest::Client,
    base_url: String,
}

/// `GET /status` — daemon + connection health (fields this CLI reads; the
/// daemon's full envelope carries more that we pass through untouched).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarStatus {
    /// True once the client has started and a channel is open (ready to
    /// publish paid writes).
    pub ready: bool,
    /// True while the BTP session / channel are still coming up.
    #[serde(default)]
    pub bootstrapping: bool,
    /// Per-event fee in base (micro) units, as a decimal string.
    #[serde(rename = "feePerEvent", default)]
    pub fee_per_event: Option<String>,
    /// Human-readable asset code for the fee (e.g. `USDC`).
    #[serde(default)]
    pub asset: Option<String>,
    /// The sidecar's own identity — the agent's keypair, scoped to it alone.
    pub identity: SidecarIdentity,
    /// Last error observed during bootstrap, if any (non-fatal).
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
    /// Everything else the daemon returned, preserved for pass-through
    /// output rather than dropped on the floor by a narrow struct.
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

/// `POST /publish-unsigned` request body — the daemon builds, signs (with its
/// own held key), and pays for the event. The caller supplies only the event
/// shell.
#[derive(Debug, Serialize)]
struct PublishUnsignedRequest {
    kind: u16,
    content: String,
    tags: Vec<Vec<String>>,
}

/// `POST /publish-unsigned` / `POST /publish` response — a paid-write receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishReceipt {
    #[serde(rename = "eventId")]
    pub event_id: String,
    /// Channel the claim was signed against — the sidecar's own, never a
    /// shared one.
    #[serde(rename = "channelId")]
    pub channel_id: String,
    /// Channel nonce after this publish.
    pub nonce: u64,
    /// The fee actually paid, in base (micro) units, as a decimal string.
    #[serde(rename = "feePaid")]
    pub fee_paid: String,
    /// Spendable channel balance after this write, when known.
    #[serde(rename = "channelBalanceAfter", default)]
    pub channel_balance_after: Option<String>,
}

/// `POST /nip59-unwrap` request body — one kind:1059 gift wrap, verbatim as
/// the relay served it.
#[derive(Debug, Serialize)]
struct Nip59UnwrapRequest<'a> {
    wrap: &'a serde_json::Value,
}

/// `POST /nip59-unwrap` response — the opened NIP-59 layers.
///
/// The sidecar is the identity custodian: it holds the agent's nostr secret
/// key, so it alone can run the two NIP-44 decryptions a gift wrap needs. It
/// hands back the plaintext rumor and, crucially, the pubkey that signed the
/// kind:13 seal — the *real* author. A rumor is unsigned by construction, so
/// its own `pubkey` field is a claim; the seal's signature is the evidence,
/// and everything downstream (the admin check in `channel_key_grant`) trusts
/// [`Self::seal_pubkey`], never the rumor's claim.
#[derive(Debug, Clone, Deserialize)]
pub struct Nip59Unwrapped {
    /// The unsigned inner event (kind:44300 for a channel-key delivery).
    pub rumor: serde_json::Value,
    /// Hex pubkey that signed the kind:13 seal.
    #[serde(rename = "sealPubkey")]
    pub seal_pubkey: String,
}

/// Uniform error envelope the daemon returns with non-2xx responses.
#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: String,
    detail: Option<String>,
    #[serde(default)]
    retryable: bool,
}

impl SidecarClient {
    pub fn new(base_url: String) -> Result<Self, CliError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(env_timeout_secs(
                "TOON_SIDECAR_TIMEOUT_SECS",
                40,
            )))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| CliError::Other(e.to_string()))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }

    /// `GET /status`.
    pub async fn status(&self) -> Result<SidecarStatus, CliError> {
        let url = format!("{}/status", self.base_url);
        let resp = self.send(self.http.get(&url), &url).await?;
        Self::parse_ok(resp).await
    }

    /// `POST /publish-unsigned` — post a plaintext message to a channel.
    ///
    /// The sidecar owns the private key: this sends only the event shell
    /// (kind, content, tags), never a signature or a mnemonic.
    pub async fn publish_unsigned(
        &self,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
    ) -> Result<PublishReceipt, CliError> {
        let url = format!("{}/publish-unsigned", self.base_url);
        let body = PublishUnsignedRequest {
            kind,
            content,
            tags,
        };
        let resp = self.send(self.http.post(&url).json(&body), &url).await?;
        Self::parse_ok(resp).await
    }

    /// `POST /nip59-unwrap` — open one gift wrap addressed to the agent.
    ///
    /// Only the sidecar can do this: unwrapping needs the agent's secret key,
    /// which this CLI never holds. A wrap this daemon cannot open is not an
    /// error worth stopping an inbox sweep for (400 = malformed or addressed
    /// to somebody else, 422 = the MAC failed), so callers get the sidecar's
    /// status code through `CliError::Sidecar` and decide for themselves.
    pub async fn nip59_unwrap(&self, wrap: &serde_json::Value) -> Result<Nip59Unwrapped, CliError> {
        let url = format!("{}/nip59-unwrap", self.base_url);
        let body = Nip59UnwrapRequest { wrap };
        let resp = self.send(self.http.post(&url).json(&body), &url).await?;
        Self::parse_ok(resp).await
    }

    /// Send a request, translating a connection-level failure into a
    /// `SidecarUnreachable` error that names the URL that was tried — the
    /// distinction the "sidecar down" acceptance criterion asks for: a dead
    /// daemon must never look like a slow or malformed response.
    async fn send(
        &self,
        req: reqwest::RequestBuilder,
        url: &str,
    ) -> Result<reqwest::Response, CliError> {
        req.send().await.map_err(|e| {
            if e.is_connect() {
                CliError::SidecarUnreachable {
                    url: url.to_string(),
                    detail: fmt_connect_error(&e),
                }
            } else {
                CliError::Network(e)
            }
        })
    }

    /// Turn a non-2xx response into `CliError::Sidecar`, carrying the
    /// daemon's own `{error, detail, retryable}` envelope through verbatim;
    /// decode a 2xx body as `T`.
    async fn parse_ok<T: serde::de::DeserializeOwned>(
        resp: reqwest::Response,
    ) -> Result<T, CliError> {
        let status = resp.status();
        if status.is_success() {
            return resp
                .json::<T>()
                .await
                .map_err(|e| CliError::Other(format!("malformed sidecar response: {e}")));
        }
        let body = resp.text().await.unwrap_or_default();
        let envelope: ErrorEnvelope = serde_json::from_str(&body).unwrap_or(ErrorEnvelope {
            error: "unknown".to_string(),
            detail: if body.is_empty() { None } else { Some(body) },
            retryable: matches!(status.as_u16(), 429 | 502 | 503 | 504),
        });
        Err(CliError::Sidecar {
            status: status.as_u16(),
            error: envelope.error,
            detail: envelope.detail,
            retryable: envelope.retryable,
        })
    }
}

/// Same source-chain walk as `client.rs`'s `fmt_reqwest_error`, kept local
/// and narrower (connect failures only) since that is the one case this
/// module classifies specially.
fn fmt_connect_error(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut source: &dyn std::error::Error = e;
    while let Some(cause) = source.source() {
        let cause_str = cause.to_string();
        if !msg.contains(&cause_str) {
            msg.push_str(": ");
            msg.push_str(&cause_str);
        }
        source = cause;
    }
    msg
}

fn env_timeout_secs(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
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

    /// Spawn a one-shot axum server on a random port, same idiom as
    /// `client.rs`'s `retry_policy_tests::test_server`.
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
    async fn status_success_path_parses_identity_and_readiness() {
        let (url, _) = test_server(|_n| {
            (
                StatusCode::OK,
                r#"{
                    "ready": true,
                    "bootstrapping": false,
                    "feePerEvent": "2000",
                    "asset": "USDC",
                    "identity": {"nostrPubkey": "abc123"},
                    "capabilities": []
                }"#
                .to_string(),
            )
        })
        .await;
        let client = SidecarClient::new(url).unwrap();
        let status = client.status().await.unwrap();
        assert!(status.ready);
        assert_eq!(status.identity.nostr_pubkey, "abc123");
        assert_eq!(status.asset.as_deref(), Some("USDC"));
    }

    #[tokio::test]
    async fn publish_unsigned_success_path_returns_receipt() {
        let (url, attempts) = test_server(|_n| {
            (
                StatusCode::OK,
                r#"{
                    "eventId": "evt1",
                    "channelId": "chan1",
                    "nonce": 3,
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
        assert_eq!(receipt.channel_id, "chan1");
        assert_eq!(receipt.nonce, 3);
        assert_eq!(receipt.fee_paid, "2000");
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "single attempt, no retry"
        );
    }

    #[tokio::test]
    async fn publish_unsigned_payment_failure_surfaces_sidecar_error() {
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
            .publish_unsigned(9, "hello".to_string(), vec![vec!["h".into(), "c1".into()]])
            .await
            .unwrap_err();
        match err {
            CliError::Sidecar {
                status,
                error,
                detail,
                retryable,
            } => {
                assert_eq!(status, 502);
                assert_eq!(error, "rejected");
                assert_eq!(detail.as_deref(), Some("insufficient channel balance"));
                assert!(!retryable);
            }
            other => panic!("expected CliError::Sidecar, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn bootstrapping_error_is_retryable() {
        let (url, _) = test_server(|_n| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                r#"{"error":"bootstrapping","detail":"channel not open yet","retryable":true}"#
                    .to_string(),
            )
        })
        .await;
        let client = SidecarClient::new(url).unwrap();
        let err = client.status().await.unwrap_err();
        match err {
            CliError::Sidecar { retryable, .. } => assert!(retryable),
            other => panic!("expected CliError::Sidecar, got {other:?}"),
        }
    }

    /// Live-proof, opt-in only: posts one real message through a REAL
    /// `toon-clientd` sidecar against the shared devnet, exercising the exact
    /// path `buzz toon send` uses.
    ///
    /// Ignored by default — `cargo test` never touches the network. To run
    /// it:
    ///
    /// 1. Start a `toon-clientd` sidecar pointed at the devnet, with a fresh
    ///    mnemonic funded on the `evm` (Base Sepolia) leg via its own
    ///    `POST /fund-wallet` (self-serve; see
    ///    https://faucet.devnet.toonprotocol.dev). `evm` is the only chain
    ///    whose devnet faucet drips BOTH gas and the settlement token —
    ///    Solana and Mina are USDC-only and expect the wallet to already
    ///    hold native gas (`packages/client/src/faucet.ts` in `toon-client`).
    /// 2. As of this writing, a daemon configured with `TOON_CLIENT_NETWORK`
    ///    set (required for ANY chain's channel client to initialize) also
    ///    runs kind:10032 bootstrap discovery, which negotiates additional
    ///    chains and can pre-track a destination's payment channel against
    ///    `supportedChains[0]` (see `ToonClient.getDefaultChainContext` in
    ///    `toon-client/packages/client/src/ToonClient.ts`) rather than the
    ///    configured `TOON_CLIENT_CHAIN` — observed live 2026-08-01 picking
    ///    `solana` even with `TOON_CLIENT_CHAIN=evm` set, which then fails
    ///    channel-open with `insufficient_gas` (Solana's faucet leg never
    ///    grants lamports). That is a `toon-client`-side apex-negotiation
    ///    detail, not something this CLI can route around — file it there if
    ///    it still reproduces. Point `TOON_SIDECAR_LIVE_URL` at a daemon/
    ///    destination pairing that lands the channel on a gas-funded chain
    ///    (`evm` reliably works) to exercise this test end-to-end.
    /// 3. Run:
    ///    ```text
    ///    TOON_SIDECAR_LIVE_URL=http://127.0.0.1:8799 \
    ///    TOON_SIDECAR_LIVE_CHANNEL=<a channel uuid> \
    ///    cargo test -p buzz-cli sidecar::tests::live_devnet_publish_round_trip -- --ignored --nocapture
    ///    ```
    /// A second client subscribed to the same relay/channel (e.g. desktop, or
    /// `toon_subscribe`/`toon_read` from the toon MCP plugin) should see the
    /// posted kind:9 event with the content below — remember the devnet
    /// relay serves EVENT payloads double-JSON-encoded, so a naive raw-WS
    /// reader will false-negative "missing" (verify via `toon_query` instead).
    #[tokio::test]
    #[ignore = "requires a live toon-clientd sidecar with a funded channel; see doc comment"]
    async fn live_devnet_publish_round_trip() {
        let Ok(url) = std::env::var("TOON_SIDECAR_LIVE_URL") else {
            eprintln!("skipped: set TOON_SIDECAR_LIVE_URL to run this live test");
            return;
        };
        let channel = std::env::var("TOON_SIDECAR_LIVE_CHANNEL")
            .unwrap_or_else(|_| "0".repeat(8) + "-0000-0000-0000-000000000000");

        let client = SidecarClient::new(url).unwrap();
        let status = client.status().await.expect("sidecar must be reachable");
        assert!(
            status.ready,
            "sidecar not ready to pay for writes — fund + open a channel first"
        );

        let receipt = client
            .publish_unsigned(
                9,
                "hello from buzz-cli's live sidecar test (buzz#15)".to_string(),
                vec![vec!["h".to_string(), channel]],
            )
            .await
            .expect("live publish-unsigned should succeed against a funded sidecar");

        println!("published {:?}", receipt);
        assert!(!receipt.event_id.is_empty());
        assert!(!receipt.channel_id.is_empty());
    }

    #[tokio::test]
    async fn sidecar_down_is_a_clear_unreachable_error_naming_the_url() {
        // Nothing is listening on this port — connection refused.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener); // free the port, guaranteed nothing answers it

        let base = format!("http://{addr}");
        let client = SidecarClient::new(base.clone()).unwrap();
        let err = client.status().await.unwrap_err();
        match &err {
            CliError::SidecarUnreachable { url, .. } => {
                assert!(url.contains(&addr.to_string()));
            }
            other => panic!("expected CliError::SidecarUnreachable, got {other:?}"),
        }
        // Message must name the exact URL, not just "network error".
        assert!(err.to_string().contains(&addr.to_string()));
        assert!(crate::error::exit_code(&err) != 0);
    }
}
