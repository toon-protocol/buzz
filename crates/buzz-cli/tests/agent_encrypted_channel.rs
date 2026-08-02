//! buzz#19 end-to-end: an agent-member joins an encrypted channel, reads it,
//! posts into it, and is locked out by a rotation.
//!
//! This drives the real `buzz` binary against two stubs:
//!
//! - a **stub TOON relay** (NIP-01 over WebSocket) that serves whatever events
//!   the test has published into it — and serves every `EVENT` frame in the
//!   devnet's double-JSON-encoded shape, so the tolerance in
//!   `toon_relay::decode_frame` is exercised over a real socket rather than
//!   only in a unit test;
//! - a **stub `toon-clientd` sidecar** that answers `/status`,
//!   `/nip59-unwrap`, and `/publish-unsigned`. It is a stub, not a fake: it
//!   holds the agent's real secret key and does a real NIP-59 unwrap and a
//!   real signature, so the bytes crossing the seam are the bytes the live
//!   daemon will produce.
//!
//! `POST /nip59-unwrap` does not exist in `toon-client` yet (it is being added
//! in parallel — see the issue). The contract mocked here is the settled one:
//!
//! ```text
//! POST /nip59-unwrap  {"wrap": <kind:1059 event JSON>}
//!   200 {"rumor": <unsigned inner event JSON>, "sealPubkey": "<hex>"}
//!   400 malformed / wrong recipient
//!   422 decrypt failure
//! ```
//!
//! What a live run additionally needs is written up at the bottom of this
//! file.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{any, get, post};
use axum::{Json, Router};
use buzz_channel_crypto::{channel_key_id, encryption_tag, open, seal, ChannelKey};
use futures_util::{SinkExt as _, StreamExt as _};
use nostr::{Event, EventBuilder, JsonUtil as _, Keys, Kind, Tag, Timestamp, UnsignedEvent};
use serde_json::{json, Value};
use tokio::net::TcpListener;

const CHANNEL: &str = "6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b";
const KIND_CHANNEL_MESSAGE: u16 = 9;
const KIND_ADMIN_LIST: u16 = 39100;
const KIND_KEY_RUMOR: u16 = 44300;

// ─── stub relay ──────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct RelayState {
    events: Arc<Mutex<Vec<Event>>>,
}

impl RelayState {
    fn publish(&self, event: Event) {
        self.events.lock().unwrap().push(event);
    }

    /// The subset of NIP-01 filtering this test needs: `kinds`, `#p`, `#h`.
    fn matching(&self, filter: &Value) -> Vec<Event> {
        let kinds: Option<Vec<u16>> = filter.get("kinds").and_then(Value::as_array).map(|k| {
            k.iter()
                .filter_map(|v| v.as_u64().map(|n| n as u16))
                .collect()
        });
        let tag_filter = |name: &str| -> Option<Vec<String>> {
            filter
                .get(format!("#{name}"))
                .and_then(Value::as_array)
                .map(|v| {
                    v.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
        };
        let p_values = tag_filter("p");
        let h_values = tag_filter("h");

        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                if let Some(kinds) = &kinds {
                    if !kinds.contains(&event.kind.as_u16()) {
                        return false;
                    }
                }
                for (name, wanted) in [("p", &p_values), ("h", &h_values)] {
                    let Some(wanted) = wanted else { continue };
                    let has = event.tags.iter().any(|tag| {
                        let row = tag.clone().to_vec();
                        row.first().map(String::as_str) == Some(name)
                            && row.get(1).is_some_and(|v| wanted.contains(v))
                    });
                    if !has {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect()
    }
}

async fn relay_socket(ws: WebSocketUpgrade, State(state): State<RelayState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| relay_session(socket, state))
}

async fn relay_session(socket: WebSocket, state: RelayState) {
    let (mut tx, mut rx) = socket.split();
    while let Some(Ok(message)) = rx.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Vec<Value>>(&text) else {
            continue;
        };
        if frame.first().and_then(Value::as_str) != Some("REQ") {
            continue;
        }
        let subscription_id = frame
            .get(1)
            .and_then(Value::as_str)
            .unwrap_or("sub")
            .to_string();
        let filter = frame.get(2).cloned().unwrap_or_else(|| json!({}));

        for event in state.matching(&filter) {
            // Devnet shape on purpose: the event payload is a JSON *string*,
            // not an inline object. A naive reader sees an empty channel.
            let payload = serde_json::to_string(&event).unwrap();
            let out = json!(["EVENT", subscription_id, payload]).to_string();
            if tx.send(Message::Text(out.into())).await.is_err() {
                return;
            }
        }
        let eose = json!(["EOSE", subscription_id]).to_string();
        if tx.send(Message::Text(eose.into())).await.is_err() {
            return;
        }
    }
}

async fn spawn_relay(state: RelayState) -> String {
    let app = Router::new()
        .route("/", any(relay_socket))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("ws://{addr}")
}

// ─── stub sidecar ────────────────────────────────────────────────────────────

#[derive(Clone)]
struct SidecarState {
    /// The agent's identity. The real daemon holds this; so does the stub,
    /// because unwrapping and signing genuinely need it.
    keys: Keys,
    relay: RelayState,
    /// Everything `/publish-unsigned` was asked to publish, for assertions.
    published: Arc<Mutex<Vec<Value>>>,
}

async fn sidecar_status(State(state): State<SidecarState>) -> Json<Value> {
    Json(json!({
        "ready": true,
        "bootstrapping": false,
        "feePerEvent": "2000",
        "asset": "USDC",
        "identity": { "nostrPubkey": state.keys.public_key().to_hex() },
    }))
}

async fn sidecar_unwrap(
    State(state): State<SidecarState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let Some(wrap) = body.get("wrap") else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error": "malformed", "detail": "no wrap field"})),
        )
            .into_response();
    };
    let Ok(wrap) = serde_json::from_value::<Event>(wrap.clone()) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error": "malformed", "detail": "not an event"})),
        )
            .into_response();
    };
    match nostr::nips::nip59::extract_rumor(&state.keys, &wrap).await {
        Ok(gift) => Json(json!({
            "rumor": serde_json::from_str::<Value>(&gift.rumor.as_json()).unwrap(),
            "sealPubkey": gift.sender.to_hex(),
        }))
        .into_response(),
        Err(e) => (
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": "decrypt-failed", "detail": e.to_string()})),
        )
            .into_response(),
    }
}

async fn sidecar_publish(
    State(state): State<SidecarState>,
    Json(body): Json<Value>,
) -> Json<Value> {
    state.published.lock().unwrap().push(body.clone());

    // Sign the shell with the agent's own key, exactly as the daemon does,
    // and land it on the relay so a subsequent read sees it.
    let kind = body["kind"].as_u64().unwrap_or(1) as u16;
    let content = body["content"].as_str().unwrap_or("").to_string();
    let tags: Vec<Tag> = body["tags"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let cells: Vec<String> = row
                        .as_array()?
                        .iter()
                        .filter_map(|c| c.as_str().map(str::to_string))
                        .collect();
                    Tag::parse(cells).ok()
                })
                .collect()
        })
        .unwrap_or_default();
    let event = EventBuilder::new(Kind::Custom(kind), content)
        .tags(tags)
        .allow_self_tagging()
        .sign_with_keys(&state.keys)
        .unwrap();
    let event_id = event.id.to_hex();
    state.relay.publish(event);

    Json(json!({
        "eventId": event_id,
        "channelId": "stub-payment-channel",
        "nonce": 1,
        "feePaid": "2000",
        "channelBalanceAfter": "998000",
    }))
}

async fn spawn_sidecar(state: SidecarState) -> String {
    let app = Router::new()
        .route("/status", get(sidecar_status))
        .route("/nip59-unwrap", post(sidecar_unwrap))
        .route("/publish-unsigned", post(sidecar_publish))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

// ─── the community, as an admin's client would publish it ────────────────────

/// A kind:39100 admin list, the shape `buildChannelAdminListEvent` produces.
fn admin_list(signer: &Keys, admins: &[&str], key: &ChannelKey, epoch: u64, at: u64) -> Event {
    let creator = signer.public_key().to_hex();
    let mut tags = vec![
        Tag::parse(["d", CHANNEL]).unwrap(),
        Tag::parse(["creator", &creator]).unwrap(),
        Tag::parse(["p", &creator, "admin"]).unwrap(),
    ];
    for admin in admins {
        tags.push(Tag::parse(["p", admin, "admin"]).unwrap());
    }
    tags.push(Tag::parse(["key", &channel_key_id(key), &epoch.to_string()]).unwrap());
    EventBuilder::new(Kind::Custom(KIND_ADMIN_LIST), "")
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from_secs(at))
        .sign_with_keys(signer)
        .unwrap()
}

/// A kind:9 channel message sealed under `key`, as desktop's write path
/// publishes it.
fn sealed_message(signer: &Keys, key: &ChannelKey, body: &str, at: u64) -> Event {
    EventBuilder::new(Kind::Custom(KIND_CHANNEL_MESSAGE), seal(body, key))
        .tags(vec![
            Tag::parse(["h", CHANNEL]).unwrap(),
            Tag::parse(encryption_tag(key)).unwrap(),
        ])
        .custom_created_at(Timestamp::from_secs(at))
        .sign_with_keys(signer)
        .unwrap()
}

/// The standard add-member flow: gift-wrap the channel key to a recipient.
/// Identical for a human and for an agent — the recipient pubkey is the only
/// thing that differs, and nothing in the flow inspects it.
async fn wrap_key_to(sender: &Keys, recipient: &Keys, key: &ChannelKey, epoch: u64) -> Event {
    let rumor = UnsignedEvent::new(
        sender.public_key(),
        Timestamp::now(),
        Kind::Custom(KIND_KEY_RUMOR),
        vec![
            Tag::parse(["h", CHANNEL]).unwrap(),
            Tag::parse(["key", &channel_key_id(key), &epoch.to_string()]).unwrap(),
            Tag::parse(["p", &recipient.public_key().to_hex()]).unwrap(),
        ],
        hex::encode(key),
    );
    EventBuilder::gift_wrap(sender, &recipient.public_key(), rumor, [])
        .await
        .unwrap()
}

// ─── driving the real binary ─────────────────────────────────────────────────

struct Cli {
    relay_url: String,
    sidecar_url: String,
    keystore: std::path::PathBuf,
}

impl Cli {
    async fn run(&self, args: &[&str]) -> (i32, Value) {
        let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_buzz"))
            .arg("--toon-relay")
            .arg(&self.relay_url)
            .arg("--sidecar-url")
            .arg(&self.sidecar_url)
            .arg("--keystore")
            .arg(&self.keystore)
            .args(args)
            // The binary must not fall back to a developer's real environment.
            .env_remove("BUZZ_TOON_RELAY_URL")
            .env_remove("BUZZ_AGENT_KEYSTORE")
            .env_remove("TOON_DAEMON_URL")
            .env_remove("BUZZ_TOON_ASSUME_PUBLIC")
            .output()
            .await
            .expect("the buzz binary should run");

        let code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let parsed = serde_json::from_str::<Value>(&stdout).unwrap_or(json!({ "stderr": stderr }));
        (code, parsed)
    }
}

/// The whole acceptance criteria for buzz#19, in the order they read:
///
/// 1. an agent is admitted by the standard add-member flow — no agent-specific
///    backdoor;
/// 2. it reads and posts encrypted content in the channel;
/// 3. rotating after removing it locks it out like any other member.
#[tokio::test]
async fn an_agent_joins_reads_posts_and_is_locked_out_by_rotation() {
    let admin = Keys::generate();
    let agent = Keys::generate();

    let epoch0: ChannelKey = [0x11; 32];
    let epoch1: ChannelKey = [0x22; 32];

    let relay = RelayState::default();
    let relay_url = spawn_relay(relay.clone()).await;
    let published = Arc::new(Mutex::new(Vec::new()));
    let sidecar_url = spawn_sidecar(SidecarState {
        keys: agent.clone(),
        relay: relay.clone(),
        published: published.clone(),
    })
    .await;

    let scratch = tempfile::tempdir().unwrap();
    let cli = Cli {
        relay_url,
        sidecar_url,
        keystore: scratch.path().join("agent-channel-keys.json"),
    };

    // ── the admin provisions the channel and admits the agent ───────────────
    relay.publish(admin_list(&admin, &[], &epoch0, 0, 1_700_000_000));
    relay.publish(sealed_message(
        &admin,
        &epoch0,
        "welcome — the deploy token is in the vault",
        1_700_000_100,
    ));
    relay.publish(wrap_key_to(&admin, &agent, &epoch0, 0).await);

    // ── 1. admission ────────────────────────────────────────────────────────
    let (code, out) = cli.run(&["toon", "inbox"]).await;
    assert_eq!(code, 0, "inbox failed: {out}");
    assert_eq!(out["accepted"].as_array().unwrap().len(), 1, "{out}");
    let accepted = &out["accepted"][0];
    assert_eq!(accepted["channel"], CHANNEL);
    assert_eq!(accepted["keyId"], channel_key_id(&epoch0));
    assert_eq!(accepted["from"], admin.public_key().to_hex());
    assert_eq!(
        out["membership"],
        json!([{ "channel": CHANNEL, "sendingKeyId": channel_key_id(&epoch0) }]),
        "the first key for a channel is what the agent sends under: {out}"
    );

    // ── 2a. the agent reads the history it was just admitted to ─────────────
    let (code, out) = cli.run(&["toon", "read", "--channel", CHANNEL]).await;
    assert_eq!(code, 0, "read failed: {out}");
    let messages = out["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["opened"], true);
    assert_eq!(
        messages[0]["content"],
        "welcome — the deploy token is in the vault"
    );

    // ── 2b. and posts an encrypted reply of its own ─────────────────────────
    let (code, out) = cli
        .run(&[
            "toon",
            "send",
            "--channel",
            CHANNEL,
            "--content",
            "acknowledged — rotating it now",
        ])
        .await;
    assert_eq!(code, 0, "send failed: {out}");
    assert_eq!(out["encrypted"], true);

    // The sidecar was handed ciphertext plus the marker tag, never plaintext.
    let shell = published.lock().unwrap().last().cloned().unwrap();
    assert_eq!(shell["kind"], KIND_CHANNEL_MESSAGE);
    let ciphertext = shell["content"].as_str().unwrap();
    assert!(
        !ciphertext.contains("rotating it now"),
        "the sidecar must never see the plaintext"
    );
    assert_eq!(
        shell["tags"],
        json!([
            ["h", CHANNEL],
            ["encrypted", "nip44-v2", channel_key_id(&epoch0)]
        ])
    );
    assert_eq!(
        open(ciphertext, &epoch0).as_deref(),
        Some("acknowledged — rotating it now"),
        "another member of the same epoch can read it"
    );

    // And it comes back through a read, opened.
    let (_, out) = cli.run(&["toon", "read", "--channel", CHANNEL]).await;
    let contents: Vec<&str> = out["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert!(contents.contains(&"acknowledged — rotating it now"));

    // ── 3. removal + rotation locks the agent out ───────────────────────────
    // The admin rotates: a new epoch, announced on the list, with the new key
    // wrapped to everyone who is still a member. The agent is not, so no wrap
    // is addressed to it. That absence is the entire mechanism.
    relay.publish(admin_list(&admin, &[], &epoch1, 1, 1_700_001_000));
    relay.publish(sealed_message(
        &admin,
        &epoch1,
        "new token: the agent must not read this",
        1_700_001_100,
    ));

    let (code, out) = cli.run(&["toon", "inbox"]).await;
    assert_eq!(code, 0, "inbox failed: {out}");
    assert!(
        out["accepted"].as_array().unwrap().is_empty(),
        "no wrap for the new epoch exists, so nothing is adopted: {out}"
    );
    assert_eq!(
        out["skipped"][0]["reason"], "stale-epoch",
        "the old wrap is still on the relay, and replaying it must not re-admit: {out}"
    );

    let (code, out) = cli.run(&["toon", "read", "--channel", CHANNEL]).await;
    assert_eq!(code, 0, "read failed: {out}");
    let messages = out["messages"].as_array().unwrap();
    let locked: Vec<&Value> = messages.iter().filter(|m| m["opened"] == false).collect();
    assert_eq!(locked.len(), 1, "exactly the post-rotation message: {out}");
    assert_eq!(locked[0]["keyId"], channel_key_id(&epoch1));
    assert!(
        locked[0]["content"]
            .as_str()
            .unwrap()
            .starts_with("[Encrypted message"),
        "a locked message renders as the placeholder, never as ciphertext"
    );
    // Slack-export semantics (ADR 0001): what it already had, it keeps.
    assert!(
        messages
            .iter()
            .any(|m| m["content"] == "welcome — the deploy token is in the vault"),
        "rotation protects the future, not the past: {out}"
    );
}

/// A stranger who wraps a key to the agent gets nowhere: the seal's signer is
/// not on the channel's validated admin list, so the key is never adopted and
/// the agent never seals anything under it.
#[tokio::test]
async fn a_key_from_a_non_admin_is_refused() {
    let admin = Keys::generate();
    let attacker = Keys::generate();
    let agent = Keys::generate();

    let genuine: ChannelKey = [0x33; 32];
    let poisoned: ChannelKey = [0x44; 32];

    let relay = RelayState::default();
    let relay_url = spawn_relay(relay.clone()).await;
    let sidecar_url = spawn_sidecar(SidecarState {
        keys: agent.clone(),
        relay: relay.clone(),
        published: Arc::new(Mutex::new(Vec::new())),
    })
    .await;

    let scratch = tempfile::tempdir().unwrap();
    let cli = Cli {
        relay_url,
        sidecar_url,
        keystore: scratch.path().join("agent-channel-keys.json"),
    };

    relay.publish(admin_list(&admin, &[], &genuine, 0, 1_700_000_000));
    relay.publish(wrap_key_to(&attacker, &agent, &poisoned, 0).await);

    let (code, out) = cli.run(&["toon", "inbox"]).await;
    assert_eq!(code, 0, "inbox failed: {out}");
    assert!(out["accepted"].as_array().unwrap().is_empty(), "{out}");
    assert_eq!(out["skipped"][0]["reason"], "sender-not-admin", "{out}");

    // Holding no key for a channel its admin list says is encrypted, the
    // agent refuses to post rather than leaking plaintext into it.
    let (code, out) = cli
        .run(&[
            "toon",
            "send",
            "--channel",
            CHANNEL,
            "--content",
            "this must never reach the relay in the clear",
        ])
        .await;
    assert_ne!(code, 0, "a keyed channel with no key must refuse: {out}");
    let message = out["stderr"].as_str().unwrap_or_default();
    assert!(message.contains("not a member"), "unexpected error: {out}");

    let (_, out) = cli.run(&["toon", "keys"]).await;
    assert!(
        out["channels"].as_array().unwrap().is_empty(),
        "the poisoned key must not be in the keystore: {out}"
    );
}

/// A key can reach a member before the admin list announces the epoch it
/// belongs to (the rotating client publishes the wraps and the list as two
/// separate paid writes, in some order, over a relay that reorders). Until the
/// validated list names it, the new key is readable but must not become what
/// the agent *sends* under — otherwise a wrap alone could redirect an agent's
/// writes into an epoch nobody else is on.
#[tokio::test]
async fn a_key_delivered_before_its_announcement_waits_then_promotes() {
    let admin = Keys::generate();
    let agent = Keys::generate();

    let epoch0: ChannelKey = [0x55; 32];
    let epoch1: ChannelKey = [0x66; 32];

    let relay = RelayState::default();
    let relay_url = spawn_relay(relay.clone()).await;
    let sidecar_url = spawn_sidecar(SidecarState {
        keys: agent.clone(),
        relay: relay.clone(),
        published: Arc::new(Mutex::new(Vec::new())),
    })
    .await;

    let scratch = tempfile::tempdir().unwrap();
    let cli = Cli {
        relay_url,
        sidecar_url,
        keystore: scratch.path().join("agent-channel-keys.json"),
    };

    relay.publish(admin_list(&admin, &[], &epoch0, 0, 1_700_000_000));
    relay.publish(wrap_key_to(&admin, &agent, &epoch0, 0).await);
    let (code, out) = cli.run(&["toon", "inbox"]).await;
    assert_eq!(code, 0, "inbox failed: {out}");
    assert_eq!(
        out["membership"][0]["sendingKeyId"],
        channel_key_id(&epoch0)
    );

    // The new epoch's wrap lands first; the list still names epoch 0.
    relay.publish(wrap_key_to(&admin, &agent, &epoch1, 1).await);
    let (code, out) = cli.run(&["toon", "inbox"]).await;
    assert_eq!(code, 0, "inbox failed: {out}");
    // Gift wraps carry randomly backdated timestamps (NIP-59), so the sweep
    // order is not the publish order — find the entry, do not index it.
    let new_epoch = out["accepted"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["keyId"] == channel_key_id(&epoch1))
        .unwrap_or_else(|| panic!("the new epoch's wrap should be accepted: {out}"));
    assert_eq!(new_epoch["adoption"], "added");
    assert!(
        out["promoted"].as_array().unwrap().is_empty(),
        "an unannounced key must not become the sending key: {out}"
    );
    assert_eq!(
        out["membership"][0]["sendingKeyId"],
        channel_key_id(&epoch0),
        "{out}"
    );

    // Now the announcement lands. No new wrap arrives with it — reconciliation
    // alone has to move the agent onto the new epoch.
    relay.publish(admin_list(&admin, &[], &epoch1, 1, 1_700_000_500));
    let (code, out) = cli.run(&["toon", "inbox"]).await;
    assert_eq!(code, 0, "inbox failed: {out}");
    assert_eq!(out["promoted"][0]["sendingKeyId"], channel_key_id(&epoch1));
    assert_eq!(out["promoted"][0]["epoch"], 1);
    assert_eq!(
        out["membership"][0]["sendingKeyId"],
        channel_key_id(&epoch1),
        "{out}"
    );

    // And a send now seals under the announced epoch.
    let (code, out) = cli
        .run(&[
            "toon",
            "send",
            "--channel",
            CHANNEL,
            "--content",
            "on the new epoch",
        ])
        .await;
    assert_eq!(code, 0, "send failed: {out}");
    let (_, out) = cli.run(&["toon", "read", "--channel", CHANNEL]).await;
    let mine = out["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["content"] == "on the new epoch")
        .unwrap_or_else(|| panic!("the agent's own message should come back: {out}"));
    assert_eq!(mine["keyId"], channel_key_id(&epoch1));
}

/// buzz#15's public write is untouched by all of this. A public channel has no
/// admin list — only private ones are provisioned with a kind:39100 — so an
/// agent holding no key posts plaintext, exactly as it did before buzz#19.
#[tokio::test]
async fn a_public_channel_still_posts_plaintext() {
    let agent = Keys::generate();
    let relay = RelayState::default();
    let relay_url = spawn_relay(relay.clone()).await;
    let published = Arc::new(Mutex::new(Vec::new()));
    let sidecar_url = spawn_sidecar(SidecarState {
        keys: agent.clone(),
        relay: relay.clone(),
        published: published.clone(),
    })
    .await;

    let scratch = tempfile::tempdir().unwrap();
    let cli = Cli {
        relay_url,
        sidecar_url,
        keystore: scratch.path().join("agent-channel-keys.json"),
    };

    // Nothing on the relay at all: no admin list, no keys, no wraps.
    let (code, out) = cli
        .run(&[
            "toon",
            "send",
            "--channel",
            CHANNEL,
            "--content",
            "hello from the sidecar",
        ])
        .await;
    assert_eq!(code, 0, "a public send must not need a channel key: {out}");
    assert_eq!(out["encrypted"], false);

    let shell = published.lock().unwrap().last().cloned().unwrap();
    assert_eq!(shell["content"], "hello from the sidecar");
    assert_eq!(
        shell["tags"],
        json!([["h", CHANNEL]]),
        "no marker tag on an unkeyed channel"
    );
}

// ─── what a live run needs ───────────────────────────────────────────────────
//
// Everything above is hermetic. To repeat it against the real devnet:
//
// 1. `toon-clientd` must expose `POST /nip59-unwrap` (in flight; contract at
//    the top of this file). Until it ships, `buzz toon inbox` against a live
//    daemon returns the daemon's 404 through `CliError::Sidecar`.
// 2. A funded sidecar: identity funded on the `evm` (Base Sepolia) leg at
//    https://faucet.devnet.toonprotocol.dev and a payment channel open, or
//    `send` fails at the paid write. `buzz toon status` reports readiness and
//    prints the funding hint when it is not ready.
// 3. An admin on a real client (desktop) has to provision the private channel
//    and add the sidecar's `nostrPubkey` as a member — the ordinary add-member
//    action, not a special one. The kind:39100 list and the kind:1059 wrap it
//    publishes are what `buzz toon inbox` then picks up.
// 4. Point the CLI at the shared relay:
//    `buzz --toon-relay wss://relay-ws.devnet.toonprotocol.dev toon inbox`
//    (that is the default), then `toon read --channel <uuid>` and
//    `toon send --channel <uuid> --content "…"`.
// 5. For the rotation half, the admin removes the agent in desktop and lets
//    the client rotate; the agent's next `read` should show the new messages
//    with `"opened": false` and its `inbox` should accept nothing.
