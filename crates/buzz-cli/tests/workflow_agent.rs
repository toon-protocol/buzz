//! buzz#21 end-to-end: the workflow-runner agent-member.
//!
//! Same harness idiom as `tests/search_agent.rs` (buzz#20): drives the real
//! `buzz toon workflow-agent` binary as a child process against a stub TOON
//! relay (NIP-01 over WebSocket, honouring `since`/`until`/`limit`) and a stub
//! `toon-clientd` sidecar. Unlike the search agent's stub, this one also
//! answers `POST /publish-unsigned` — the workflow agent's whole point is a
//! *paid write* — signing with the agent's real key and feeding the result
//! back into the stub relay, so the loop-prevention tests can observe the
//! agent's own action event exactly as a real relay round trip would produce
//! it.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{any, get, post};
use axum::{Json, Router};
use buzz_channel_crypto::{channel_key_id, encryption_tag, seal, ChannelKey};
use futures_util::{SinkExt as _, StreamExt as _};
use nostr::{Event, EventBuilder, JsonUtil as _, Keys, Kind, Tag, Timestamp, UnsignedEvent};
use serde_json::{json, Value};
use tokio::io::AsyncBufReadExt as _;
use tokio::net::TcpListener;

/// The channel the agent is admitted to.
const MEMBER: &str = "6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b";
/// The channel it is not. Same admin, same relay, no wrap ever addressed to
/// this agent for it.
const CONTROL: &str = "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a";

const KIND_CHANNEL_MESSAGE: u16 = 9;
const KIND_ADMIN_LIST: u16 = 39100;
const KIND_KEY_RUMOR: u16 = 44300;

const EPOCH0: ChannelKey = [0x11; 32];
const CONTROL_KEY: ChannelKey = [0x33; 32];

// ─── stub relay ──────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct RelayState {
    events: Arc<Mutex<Vec<Event>>>,
}

impl RelayState {
    fn publish(&self, event: Event) {
        self.events.lock().unwrap().push(event);
    }

    fn all(&self) -> Vec<Event> {
        self.events.lock().unwrap().clone()
    }

    /// `kinds`, `#p`, `#h`, `since`, `until`, `limit` — same semantics as
    /// `tests/search_agent.rs`'s stub: `since`/`until` inclusive, `limit`
    /// returns the newest N, exactly NIP-01.
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
        let e_values = tag_filter("e");
        let since = filter.get("since").and_then(Value::as_u64);
        let until = filter.get("until").and_then(Value::as_u64);
        let limit = filter.get("limit").and_then(Value::as_u64).unwrap_or(500) as usize;

        let mut matches: Vec<Event> = self
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                if let Some(kinds) = &kinds {
                    if !kinds.contains(&event.kind.as_u16()) {
                        return false;
                    }
                }
                let at = event.created_at.as_secs();
                if since.is_some_and(|floor| at < floor) || until.is_some_and(|cap| at > cap) {
                    return false;
                }
                for (name, wanted) in [("p", &p_values), ("h", &h_values), ("e", &e_values)] {
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
            .collect();

        matches.sort_by_key(|event| std::cmp::Reverse(event.created_at));
        matches.truncate(limit);
        matches
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
            // Devnet shape on purpose (buzz#19): the payload is a JSON string.
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

/// Unlike the search agent's stub (read-only), this one also signs and
/// "delivers" `/publish-unsigned` writes into the shared `RelayState` — the
/// workflow agent's action is a paid write, and the loop-prevention tests
/// need to see the agent's own event come back through a real read.
#[derive(Clone)]
struct SidecarState {
    keys: Keys,
    relay: RelayState,
    /// Monotonic clock for published events, so a burst of actions in one
    /// process tick still gets distinct, strictly increasing timestamps.
    clock: Arc<AtomicI64>,
    nonce: Arc<AtomicI64>,
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
    let Some(wrap) = body
        .get("wrap")
        .and_then(|w| serde_json::from_value::<Event>(w.clone()).ok())
    else {
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

async fn sidecar_publish_unsigned(
    State(state): State<SidecarState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let kind = body.get("kind").and_then(Value::as_u64).unwrap_or(9) as u16;
    let content = body
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tags: Vec<Vec<String>> = body
        .get("tags")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    row.as_array().map(|r| {
                        r.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect::<Vec<_>>()
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let channel_id = tags
        .iter()
        .find(|t| t.first().map(String::as_str) == Some("h"))
        .and_then(|t| t.get(1).cloned())
        .unwrap_or_default();

    let at = state.clock.fetch_add(1, Ordering::SeqCst);
    let nostr_tags: Vec<Tag> = tags.iter().map(|t| Tag::parse(t).unwrap()).collect();
    let event = EventBuilder::new(Kind::Custom(kind), content)
        .tags(nostr_tags)
        .custom_created_at(Timestamp::from_secs(at as u64))
        .sign_with_keys(&state.keys)
        .unwrap();

    let event_id = event.id.to_hex();
    state.relay.publish(event);

    let nonce = state.nonce.fetch_add(1, Ordering::SeqCst);
    Json(json!({
        "eventId": event_id,
        "channelId": channel_id,
        "nonce": nonce,
        "feePaid": "2000",
        "channelBalanceAfter": "999998000",
    }))
    .into_response()
}

async fn spawn_sidecar(state: SidecarState) -> String {
    let app = Router::new()
        .route("/status", get(sidecar_status))
        .route("/nip59-unwrap", post(sidecar_unwrap))
        .route("/publish-unsigned", post(sidecar_publish_unsigned))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

// ─── the community, as an admin's client would publish it ────────────────────

fn admin_list(signer: &Keys, channel: &str, key: &ChannelKey, epoch: u64, at: u64) -> Event {
    let creator = signer.public_key().to_hex();
    EventBuilder::new(Kind::Custom(KIND_ADMIN_LIST), "")
        .tags(vec![
            Tag::parse(["d", channel]).unwrap(),
            Tag::parse(["creator", &creator]).unwrap(),
            Tag::parse(["p", &creator, "admin"]).unwrap(),
            Tag::parse(["key", &channel_key_id(key), &epoch.to_string()]).unwrap(),
        ])
        .allow_self_tagging()
        .custom_created_at(Timestamp::from_secs(at))
        .sign_with_keys(signer)
        .unwrap()
}

fn sealed_message(signer: &Keys, channel: &str, key: &ChannelKey, body: &str, at: u64) -> Event {
    EventBuilder::new(Kind::Custom(KIND_CHANNEL_MESSAGE), seal(body, key))
        .tags(vec![
            Tag::parse(["h", channel]).unwrap(),
            Tag::parse(encryption_tag(key)).unwrap(),
        ])
        .custom_created_at(Timestamp::from_secs(at))
        .sign_with_keys(signer)
        .unwrap()
}

async fn wrap_key_to(
    sender: &Keys,
    recipient: &Keys,
    channel: &str,
    key: &ChannelKey,
    epoch: u64,
) -> Event {
    let rumor = UnsignedEvent::new(
        sender.public_key(),
        Timestamp::now(),
        Kind::Custom(KIND_KEY_RUMOR),
        vec![
            Tag::parse(["h", channel]).unwrap(),
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

struct Agent {
    child: tokio::process::Child,
    log: Arc<Mutex<Vec<Value>>>,
}

struct Fixture {
    relay_url: String,
    sidecar_url: String,
    scratch: tempfile::TempDir,
}

impl Fixture {
    fn keystore(&self) -> std::path::PathBuf {
        self.scratch.path().join("agent-channel-keys.json")
    }

    fn state(&self) -> std::path::PathBuf {
        self.scratch.path().join("workflow-agent-state.json")
    }

    fn workflows_dir(&self) -> std::path::PathBuf {
        let dir = self.scratch.path().join("workflows");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_workflow(&self, name: &str, yaml: &str) -> std::path::PathBuf {
        let path = self.workflows_dir().join(name);
        std::fs::write(&path, yaml).unwrap();
        path
    }

    async fn start_agent(&self, workflows: &std::path::Path, page_size: u32, once: bool) -> Agent {
        let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_buzz"));
        cmd.arg("--toon-relay")
            .arg(&self.relay_url)
            .arg("--sidecar-url")
            .arg(&self.sidecar_url)
            .arg("--keystore")
            .arg(self.keystore())
            .args(["toon", "workflow-agent"])
            .arg("--workflows")
            .arg(workflows)
            .arg("--state")
            .arg(self.state())
            .args([
                "--poll-interval",
                "1",
                "--page-size",
                &page_size.to_string(),
            ])
            .env_remove("BUZZ_TOON_RELAY_URL")
            .env_remove("BUZZ_AGENT_KEYSTORE")
            .env_remove("BUZZ_WORKFLOW_STATE")
            .env_remove("TOON_DAEMON_URL")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if once {
            cmd.arg("--once");
        }

        let mut child = cmd.spawn().expect("the buzz binary should run");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let log: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));

        let sink = Arc::clone(&log);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    sink.lock().unwrap().push(value);
                }
            }
        });
        let sink = Arc::clone(&log);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    sink.lock().unwrap().push(value);
                }
            }
        });

        Agent { child, log }
    }
}

impl Agent {
    async fn wait_for_exit(&mut self, timeout: Duration) -> std::process::ExitStatus {
        tokio::time::timeout(timeout, self.child.wait())
            .await
            .expect("the agent should exit within the timeout")
            .expect("waiting on the child should succeed")
    }

    async fn wait_for_cycles(&self, n: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let cycles = self.cycles().len();
            if cycles >= n {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the agent completed {cycles} of {n} cycles; log: {:?}",
                self.log.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn cycles(&self) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line["event"] == "workflow-agent-cycle")
            .cloned()
            .collect()
    }

    fn sent_actions(&self) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line["event"] == "workflow-action-sent")
            .cloned()
            .collect()
    }

    /// Actions refused before a publish was even attempted — no held key for
    /// the destination channel (buzz#22).
    fn refused_actions(&self) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line["event"] == "workflow-action-refused")
            .cloned()
            .collect()
    }

    async fn wait_for_sent(&self, n: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let sent = self.sent_actions().len();
            if sent >= n {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the agent sent {sent} of {n} actions; log: {:?}",
                self.log.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn wait_for_refused(&self, n: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let refused = self.refused_actions().len();
            if refused >= n {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the agent refused {refused} of {n} actions; log: {:?}",
                self.log.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn stop(mut self) {
        let _ = self.child.kill().await;
    }
}

/// The world every test starts from: two encrypted channels provisioned by
/// the same admin, a key wrapped to the agent for exactly one of them, and a
/// shared `RelayState` the stub sidecar also publishes into.
async fn fixture(agent: &Keys) -> (Fixture, RelayState, Keys) {
    let admin = Keys::generate();
    let relay = RelayState::default();
    let relay_url = spawn_relay(relay.clone()).await;
    let sidecar_url = spawn_sidecar(SidecarState {
        keys: agent.clone(),
        relay: relay.clone(),
        clock: Arc::new(AtomicI64::new(1_700_001_000)),
        nonce: Arc::new(AtomicI64::new(1)),
    })
    .await;

    relay.publish(admin_list(&admin, MEMBER, &EPOCH0, 0, 1_700_000_000));
    relay.publish(admin_list(&admin, CONTROL, &CONTROL_KEY, 0, 1_700_000_000));
    relay.publish(wrap_key_to(&admin, agent, MEMBER, &EPOCH0, 0).await);

    (
        Fixture {
            relay_url,
            sidecar_url,
            scratch: tempfile::tempdir().unwrap(),
        },
        relay,
        admin,
    )
}

const GREETER_YAML: &str =
    "version: 1\nname: greeter\ntrigger:\n  contains: hello\naction:\n  reply: hello back\n";

// ─── the acceptance criteria ─────────────────────────────────────────────────

/// A matching message in a held channel fires the workflow, and the reply
/// lands sealed under the channel's key.
#[tokio::test]
async fn a_matching_message_fires_and_the_reply_lands_sealed() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let workflow = fixture.write_workflow("greeter.yaml", GREETER_YAML);

    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "well hello there",
        1_700_000_100,
    ));

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_sent(1).await;

    let sent = &agent.sent_actions()[0];
    assert_eq!(sent["workflow"], "greeter");
    assert_eq!(sent["channel"], MEMBER);

    let action_id = sent["actionEvent"].as_str().unwrap();
    let published = relay
        .all()
        .into_iter()
        .find(|e| e.id.to_hex() == action_id)
        .expect("the action event should have reached the relay");
    assert_eq!(published.pubkey, agent_keys.public_key());

    // Sealed, not plaintext: the wire content must not contain the reply text.
    assert!(!published.content.contains("hello back"));
    let opened = buzz_channel_crypto::open(&published.content, &EPOCH0)
        .expect("the reply must open under the channel's key");
    assert_eq!(opened, "hello back");

    let has_marker = published.tags.iter().any(|t| {
        let row = t.clone().to_vec();
        row.first().map(String::as_str) == Some("client")
            && row.get(1).map(String::as_str) == Some("buzz-workflow")
    });
    assert!(has_marker, "action event must carry the client marker tag");

    agent.stop().await;
}

/// A workflow whose reply matches its own trigger does not loop: the agent's
/// own action event is never evaluated, so "hello back" containing "hello"
/// never causes a second reply.
#[tokio::test]
async fn a_self_matching_reply_does_not_loop() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let workflow = fixture.write_workflow("greeter.yaml", GREETER_YAML);

    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "hello team",
        1_700_000_100,
    ));

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_sent(1).await;

    // Run several more cycles. If the agent's own reply re-triggered the
    // workflow, `sent` would keep growing without bound.
    agent.wait_for_cycles(4).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        agent.sent_actions().len(),
        1,
        "the agent's own reply must not re-trigger the workflow: {:?}",
        agent.log.lock().unwrap()
    );

    agent.stop().await;
}

/// A message in a channel this agent was never admitted to is never
/// evaluated — membership by construction, identical to buzz#20.
#[tokio::test]
async fn a_message_in_a_non_member_channel_never_fires() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let workflow = fixture.write_workflow("greeter.yaml", GREETER_YAML);

    relay.publish(sealed_message(
        &admin,
        CONTROL,
        &CONTROL_KEY,
        "hello from a channel this agent cannot read",
        1_700_000_100,
    ));

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_cycles(3).await;

    assert!(
        agent.sent_actions().is_empty(),
        "a channel with no held key must never fire, even when its plaintext (were it \
readable) would match: {:?}",
        agent.log.lock().unwrap()
    );

    agent.stop().await;
}

/// Restart semantics: an event is evaluated at most once. A second `--once`
/// run over the same state file must not re-fire on a message the first run
/// already evaluated.
#[tokio::test]
async fn a_restart_does_not_re_fire_on_an_already_evaluated_event() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let workflow = fixture.write_workflow("greeter.yaml", GREETER_YAML);

    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "hello once",
        1_700_000_100,
    ));

    let mut first = fixture.start_agent(&workflow, 50, true).await;
    let status = first.wait_for_exit(Duration::from_secs(20)).await;
    assert!(status.success(), "first --once run should exit cleanly");
    assert_eq!(
        first.sent_actions().len(),
        1,
        "log: {:?}",
        first.log.lock().unwrap()
    );

    let mut second = fixture.start_agent(&workflow, 50, true).await;
    let status = second.wait_for_exit(Duration::from_secs(20)).await;
    assert!(status.success(), "second --once run should exit cleanly");
    assert!(
        second.sent_actions().is_empty(),
        "a restart must not re-fire on an event the state file already recorded as \
evaluated: {:?}",
        second.log.lock().unwrap()
    );

    // The trigger message is still the only channel history — a sanity check
    // that the test did not accidentally pass because nothing was evaluated
    // at all.
    let cycle = &second.cycles()[0];
    let channel_report = cycle["report"]["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel"] == MEMBER)
        .expect("the member channel should still be walked");
    assert!(
        channel_report["seen"].as_u64().unwrap() >= 1,
        "the walk must still see the trigger event, just not re-fire on it: {channel_report}"
    );
}

/// A malformed workflow definition fails loud: the process refuses to start
/// rather than running with zero (or partial) workflows loaded.
#[tokio::test]
async fn a_malformed_workflow_file_fails_loud_at_startup() {
    let agent_keys = Keys::generate();
    let (fixture, _relay, _admin) = fixture(&agent_keys).await;
    // Missing the required `version` field.
    let workflow = fixture.write_workflow(
        "bad.yaml",
        "trigger:\n  contains: hello\naction:\n  reply: hi\n",
    );

    let mut agent = fixture.start_agent(&workflow, 50, true).await;
    let status = agent.wait_for_exit(Duration::from_secs(10)).await;
    assert!(
        !status.success(),
        "a malformed workflow file must not let the agent start"
    );
}

// ─── buzz#22: the parity port ────────────────────────────────────────────────

const PING_YAML: &str =
    "version: 1\nname: ping\ntrigger:\n  contains: ping\naction:\n  reply: pong\n";
const PONG_YAML: &str =
    "version: 1\nname: pong\ntrigger:\n  contains: pong\naction:\n  reply: ping\n";

/// The acceptance criterion issue #22 calls out by name: a deliberately
/// self-triggering *pair* of workflows (A's action matches B's trigger, and
/// vice versa) must demonstrably terminate rather than ping-pong forever.
/// Both are loaded into one runner here, so `is_own_event` is what actually
/// stops it (the single-runner leg of loop prevention) — the multi-runner leg
/// the marker tag buys is exercised separately by
/// `a_foreign_marked_workflow_action_never_fires` below.
#[tokio::test]
async fn a_cross_triggering_pair_of_workflows_terminates() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    fixture.write_workflow("ping.yaml", PING_YAML);
    fixture.write_workflow("pong.yaml", PONG_YAML);

    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "ping",
        1_700_000_100,
    ));

    let agent = fixture
        .start_agent(&fixture.workflows_dir(), 50, false)
        .await;
    agent.wait_for_sent(1).await;

    // Several more cycles: if the pair kept re-triggering each other, `sent`
    // would keep growing without bound instead of stopping at one.
    agent.wait_for_cycles(4).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        agent.sent_actions().len(),
        1,
        "a cross-triggering pair of workflows must terminate after one hop: {:?}",
        agent.log.lock().unwrap()
    );

    agent.stop().await;
}

/// The multi-runner leg: an event carrying the `["client", "buzz-workflow"]`
/// marker tag, authored by a *different* identity than this agent's own,
/// must never fire — `is_own_event` alone would let it through (it is not
/// this identity's event), so this exercises `is_workflow_action_event`
/// specifically.
#[tokio::test]
async fn a_foreign_marked_workflow_action_never_fires() {
    let agent_keys = Keys::generate();
    let (fixture, relay, _admin) = fixture(&agent_keys).await;
    let workflow = fixture.write_workflow("greeter.yaml", GREETER_YAML);

    // A third identity's own workflow action: content that would otherwise
    // match `GREETER_YAML`'s trigger, tagged exactly as this codebase's own
    // `send_message` tags its actions.
    let other_runner = Keys::generate();
    let marked = EventBuilder::new(
        Kind::Custom(KIND_CHANNEL_MESSAGE),
        seal("well hello there", &EPOCH0),
    )
    .tags(vec![
        Tag::parse(["h", MEMBER]).unwrap(),
        Tag::parse(encryption_tag(&EPOCH0)).unwrap(),
        Tag::parse(["client", "buzz-workflow"]).unwrap(),
    ])
    .custom_created_at(Timestamp::from_secs(1_700_000_100))
    .sign_with_keys(&other_runner)
    .unwrap();
    relay.publish(marked);

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_cycles(3).await;

    assert!(
        agent.sent_actions().is_empty(),
        "a foreign workflow-action-marked event must never fire, regardless of who signed it: \
{:?}",
        agent.log.lock().unwrap()
    );

    agent.stop().await;
}

/// A `schedule:` trigger fires on the wall clock against a live relay, with
/// no incoming message at all.
#[tokio::test]
async fn a_schedule_workflow_fires_on_time() {
    let agent_keys = Keys::generate();
    let (fixture, relay, _admin) = fixture(&agent_keys).await;
    let yaml = format!(
        "version: 1\nname: heartbeat\ntrigger:\n  schedule: '* * * * * * *'\n\
action:\n  reply: heartbeat\n  channel: {MEMBER}\n"
    );
    let workflow = fixture.write_workflow("heartbeat.yaml", &yaml);

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_sent(1).await;

    let sent = &agent.sent_actions()[0];
    assert_eq!(sent["workflow"], "heartbeat");
    assert_eq!(sent["targetChannel"], MEMBER);

    let action_id = sent["actionEvent"].as_str().unwrap();
    let published = relay
        .all()
        .into_iter()
        .find(|e| e.id.to_hex() == action_id)
        .expect("the scheduled action should have reached the relay");
    assert_eq!(published.pubkey, agent_keys.public_key());

    agent.stop().await;
}

/// `action.channel` naming a channel this identity holds no key for is
/// refused loudly — never silently dropped, never sent plaintext, and never
/// retried into a queue.
#[tokio::test]
async fn a_cross_channel_action_the_runner_holds_no_key_for_is_refused() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let yaml = format!(
        "version: 1\nname: escalate\ntrigger:\n  contains: escalate\n\
action:\n  reply: escalated\n  channel: {CONTROL}\n"
    );
    let workflow = fixture.write_workflow("escalate.yaml", &yaml);

    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "please escalate this",
        1_700_000_100,
    ));

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_refused(1).await;

    assert!(
        agent.sent_actions().is_empty(),
        "a refused cross-channel action must never be sent: {:?}",
        agent.log.lock().unwrap()
    );
    let refused = &agent.refused_actions()[0];
    assert_eq!(refused["workflow"], "escalate");
    assert_eq!(refused["targetChannel"], CONTROL);

    agent.stop().await;
}

// ─── buzz#52: reaction_added trigger / add_reaction action ─────────────────

const KIND_REACTION: u16 = 7;

/// A matching message fires `action.add_reaction`: the published event is an
/// unsealed kind:7 reaction whose `e` tag targets the triggering message.
#[tokio::test]
async fn a_matching_message_fires_an_add_reaction_action() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let yaml = "version: 1\nname: triage\ntrigger:\n  contains: todo\n\
action:\n  add_reaction:\n    emoji: eyes\n";
    let workflow = fixture.write_workflow("triage.yaml", yaml);

    let trigger = sealed_message(&admin, MEMBER, &EPOCH0, "a todo for later", 1_700_000_100);
    let trigger_id = trigger.id.to_hex();
    relay.publish(trigger);

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_sent(1).await;

    let sent = &agent.sent_actions()[0];
    assert_eq!(sent["workflow"], "triage");
    assert_eq!(sent["channel"], MEMBER);

    let action_id = sent["actionEvent"].as_str().unwrap();
    let published = relay
        .all()
        .into_iter()
        .find(|e| e.id.to_hex() == action_id)
        .expect("the reaction event should have reached the relay");
    assert_eq!(published.pubkey, agent_keys.public_key());
    assert_eq!(published.kind.as_u16(), KIND_REACTION);
    // Unsealed: NIP-25 reactions have no encryption story.
    assert_eq!(published.content, "eyes");

    let e_target = published.tags.iter().find_map(|t| {
        let row = t.clone().to_vec();
        (row.first().map(String::as_str) == Some("e")).then(|| row.get(1).cloned())
    });
    assert_eq!(e_target.flatten().as_deref(), Some(trigger_id.as_str()));

    let has_marker = published.tags.iter().any(|t| {
        let row = t.clone().to_vec();
        row.first().map(String::as_str) == Some("client")
            && row.get(1).map(String::as_str) == Some("buzz-workflow")
    });
    assert!(has_marker, "action event must carry the client marker tag");

    agent.stop().await;
}

/// The end-to-end shape of the relay-scoping workaround
/// `docs/workflow-agent-parity.md` describes: a reaction landing on a
/// message the tail walk has already seen fires `reaction_added`, scoped by
/// `#e` against that message's own id (never `#h` — NIP-25 reactions carry
/// no channel tag).
#[tokio::test]
async fn a_reaction_on_a_seen_message_fires_a_reaction_added_workflow() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let yaml = "version: 1\nname: triage\ntrigger:\n  reaction_added: true\n  emoji: clipboard\n\
action:\n  add_reaction:\n    emoji: eyes\n";
    let workflow = fixture.write_workflow("triage.yaml", yaml);

    let target = sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "a message to react to",
        1_700_000_100,
    );
    let target_id = target.id.to_hex();
    relay.publish(target);

    let agent = fixture.start_agent(&workflow, 50, false).await;
    // Give the agent at least one cycle to observe the message (and so scope
    // its recently-seen window to it) before the reaction lands.
    agent.wait_for_cycles(1).await;

    let reaction = EventBuilder::new(Kind::Custom(KIND_REACTION), "clipboard")
        .tags(vec![Tag::parse(["e", &target_id]).unwrap()])
        .custom_created_at(Timestamp::from_secs(1_700_000_200))
        .sign_with_keys(&admin)
        .unwrap();
    relay.publish(reaction);

    agent.wait_for_sent(1).await;

    let sent = &agent.sent_actions()[0];
    assert_eq!(sent["workflow"], "triage");

    let action_id = sent["actionEvent"].as_str().unwrap();
    let published = relay
        .all()
        .into_iter()
        .find(|e| e.id.to_hex() == action_id)
        .expect("the add_reaction action should have reached the relay");
    assert_eq!(published.pubkey, agent_keys.public_key());
    assert_eq!(published.kind.as_u16(), KIND_REACTION);
    assert_eq!(published.content, "eyes");

    let e_target = published.tags.iter().find_map(|t| {
        let row = t.clone().to_vec();
        (row.first().map(String::as_str) == Some("e")).then(|| row.get(1).cloned())
    });
    assert_eq!(e_target.flatten().as_deref(), Some(target_id.as_str()));

    agent.stop().await;
}

/// The `emoji` filter actually filters: a reaction with a different emoji
/// never fires a `reaction_added` workflow scoped to one.
#[tokio::test]
async fn a_reaction_added_emoji_filter_ignores_other_emoji() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let yaml = "version: 1\nname: triage\ntrigger:\n  reaction_added: true\n  emoji: clipboard\n\
action:\n  add_reaction:\n    emoji: eyes\n";
    let workflow = fixture.write_workflow("triage.yaml", yaml);

    let target = sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "a message to react to",
        1_700_000_100,
    );
    let target_id = target.id.to_hex();
    relay.publish(target);

    let agent = fixture.start_agent(&workflow, 50, false).await;
    agent.wait_for_cycles(1).await;

    let reaction = EventBuilder::new(Kind::Custom(KIND_REACTION), "thumbsup")
        .tags(vec![Tag::parse(["e", &target_id]).unwrap()])
        .custom_created_at(Timestamp::from_secs(1_700_000_200))
        .sign_with_keys(&admin)
        .unwrap();
    relay.publish(reaction);

    agent.wait_for_cycles(4).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        agent.sent_actions().is_empty(),
        "a reaction with the wrong emoji must not fire an emoji-filtered workflow: {:?}",
        agent.log.lock().unwrap()
    );

    agent.stop().await;
}

// ─── buzz#52: admin_added trigger ───────────────────────────────────────────

/// A channel gaining an admin fires `admin_added` — but only on the diff
/// after the first cycle has already seeded a snapshot; the pre-existing
/// creator admin from `fixture`'s own genesis list must not itself be
/// reported as "just joined".
#[tokio::test]
async fn a_newly_added_admin_fires_an_admin_added_workflow() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys).await;
    let yaml =
        "version: 1\nname: welcome\ntrigger:\n  admin_added: true\naction:\n  reply: welcome aboard\n";
    let workflow = fixture.write_workflow("welcome.yaml", yaml);

    let agent = fixture.start_agent(&workflow, 50, false).await;
    // Let the first cycle seed the snapshot from `fixture`'s own genesis
    // admin list before a real promotion happens.
    agent.wait_for_cycles(1).await;
    assert!(
        agent.sent_actions().is_empty(),
        "the pre-existing creator admin must not itself fire admin_added: {:?}",
        agent.log.lock().unwrap()
    );

    let new_admin = Keys::generate();
    let creator = admin.public_key().to_hex();
    let promotion = EventBuilder::new(Kind::Custom(KIND_ADMIN_LIST), "")
        .tags(vec![
            Tag::parse(["d", MEMBER]).unwrap(),
            Tag::parse(["creator", &creator]).unwrap(),
            Tag::parse(["p", &creator, "admin"]).unwrap(),
            Tag::parse(["p", &new_admin.public_key().to_hex(), "admin"]).unwrap(),
            Tag::parse(["key", &channel_key_id(&EPOCH0), "0"]).unwrap(),
        ])
        .allow_self_tagging()
        .custom_created_at(Timestamp::from_secs(1_700_000_500))
        .sign_with_keys(&admin)
        .unwrap();
    relay.publish(promotion);

    agent.wait_for_sent(1).await;

    let sent = &agent.sent_actions()[0];
    assert_eq!(sent["workflow"], "welcome");
    assert_eq!(sent["channel"], MEMBER);

    agent.stop().await;
}
