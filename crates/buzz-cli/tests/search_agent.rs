//! buzz#20 end-to-end: the search indexer agent-member.
//!
//! Drives the real `buzz toon search-agent` binary as a long-running child
//! process against two stubs, in the style buzz#19 established
//! (`tests/agent_encrypted_channel.rs`):
//!
//! - a **stub TOON relay** speaking NIP-01 over a WebSocket, which this time
//!   honours `since`, `until` and `limit` — the search agent's whole paging
//!   story is in those three, so a relay that ignored them would let a broken
//!   walk pass;
//! - a **stub `toon-clientd` sidecar** answering `/status` and `/nip59-unwrap`
//!   with the agent's real key and a real NIP-59 unwrap. The search agent
//!   never writes, so `/publish-unsigned` is not needed.
//!
//! Every assertion below is about *plaintext an agent was or was not entitled
//! to read*, observed through the same loopback HTTP endpoint the desktop
//! would use. The three privacy invariants each get their own test, and the
//! control channel — provisioned, populated, and never wrapped to this agent —
//! is what proves membership-by-construction rather than a filter that happens
//! to be applied.

use std::net::SocketAddr;
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
/// The channel it is not. Same shape, same relay, same admin — the only
/// difference is that no wrap is ever addressed to the agent for it.
const CONTROL: &str = "0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a";

const KIND_CHANNEL_MESSAGE: u16 = 9;
const KIND_ADMIN_LIST: u16 = 39100;
const KIND_KEY_RUMOR: u16 = 44300;

const EPOCH0: ChannelKey = [0x11; 32];
const EPOCH1: ChannelKey = [0x22; 32];
const CONTROL_KEY: ChannelKey = [0x33; 32];

/// A word that appears only in the control channel. If it is ever returned,
/// the agent has indexed something it holds no key for.
const CONTROL_SECRET: &str = "capybara";
/// A word that appears only after the rotation the agent was excluded from.
const POST_ROTATION_SECRET: &str = "narwhal";

// ─── stub relay ──────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct RelayState {
    events: Arc<Mutex<Vec<Event>>>,
}

impl RelayState {
    fn publish(&self, event: Event) {
        self.events.lock().unwrap().push(event);
    }

    /// `kinds`, `#p`, `#h`, `since`, `until`, `limit`.
    ///
    /// `since`/`until` are inclusive and `limit` returns the **newest** N
    /// matches, exactly as NIP-01 specifies — that combination is what makes a
    /// naive `since`-only tail lose the middle of a burst, so the stub has to
    /// model it faithfully for the test to mean anything.
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
            .collect();

        // Newest first, then take `limit` — the relay hands back the most
        // recent window, never an arbitrary one.
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

#[derive(Clone)]
struct SidecarState {
    keys: Keys,
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

async fn spawn_sidecar(state: SidecarState) -> String {
    let app = Router::new()
        .route("/status", get(sidecar_status))
        .route("/nip59-unwrap", post(sidecar_unwrap))
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

/// A running `buzz toon search-agent` child, plus everything needed to restart
/// it over the same on-disk state.
struct Agent {
    child: tokio::process::Child,
    /// `http://127.0.0.1:<port>` — read from the startup line the agent prints,
    /// so `--port 0` is race-free rather than a guessed free port.
    url: String,
    /// Every JSON line the agent has printed since it started. Drained on a
    /// background task, because a child whose stdout pipe fills up blocks.
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

    fn index(&self) -> std::path::PathBuf {
        self.scratch.path().join("search-index.json")
    }

    /// Start the agent. `page_size` is deliberately tiny in most tests so the
    /// backfill and tail walks actually page rather than swallowing the whole
    /// channel in one request.
    async fn start_agent(&self, page_size: u32) -> Agent {
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_buzz"))
            .arg("--toon-relay")
            .arg(&self.relay_url)
            .arg("--sidecar-url")
            .arg(&self.sidecar_url)
            .arg("--keystore")
            .arg(self.keystore())
            .args([
                "toon",
                "search-agent",
                "--port",
                "0",
                "--poll-interval",
                "1",
                "--page-size",
                &page_size.to_string(),
            ])
            .arg("--index")
            .arg(self.index())
            .env_remove("BUZZ_TOON_RELAY_URL")
            .env_remove("BUZZ_AGENT_KEYSTORE")
            .env_remove("BUZZ_SEARCH_INDEX")
            .env_remove("TOON_DAEMON_URL")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("the buzz binary should run");

        let stdout = child.stdout.take().expect("piped stdout");
        let log: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();

        let sink = Arc::clone(&log);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            let mut tx = Some(tx);
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if value["event"] == "search-agent-started" {
                    if let (Some(tx), Some(url)) = (tx.take(), value["queryUrl"].as_str()) {
                        let _ = tx.send(url.to_string());
                    }
                }
                sink.lock().unwrap().push(value);
            }
        });

        let url = tokio::time::timeout(Duration::from_secs(20), rx)
            .await
            .expect("the agent should print its startup line")
            .expect("the agent should stay up long enough to report its port");

        Agent { child, url, log }
    }
}

impl Agent {
    async fn get(&self, path: &str) -> Value {
        reqwest::get(format!("{}{path}", self.url))
            .await
            .expect("the query endpoint should answer")
            .json()
            .await
            .expect("the query endpoint should answer JSON")
    }

    async fn search(&self, q: &str, channels: &[&str]) -> Value {
        let scope = channels.join(",");
        self.get(&format!(
            "/search?q={}&channels={scope}&limit=50",
            urlencode(q)
        ))
        .await
    }

    /// Poll `/health` until the index holds at least `count` documents.
    ///
    /// Polling rather than sleeping a fixed interval: the agent is a real
    /// process doing real crypto, and a timing-based test is a flake waiting
    /// for a slow CI box.
    async fn wait_for_documents(&self, count: usize) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let health = self.get("/health").await;
            if health["documents"].as_u64().unwrap_or(0) as usize >= count {
                return health;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the agent never reached {count} documents; last health: {health}, log: {:?}",
                self.log.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Wait for at least `n` completed ingest cycles, so a test can assert
    /// that something did *not* get indexed rather than racing the loop.
    async fn wait_for_cycles(&self, n: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let cycles = self
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|line| line["event"] == "search-agent-cycle")
                .count();
            if cycles >= n {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the agent completed {cycles} of {n} cycles"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Wait until a cycle reports `channel`'s backwards walk exhausted.
    ///
    /// Document count alone is not the same signal: the tail walk indexes the
    /// head page on cycle one, so the last page of history can still be
    /// outstanding when every message happens to be indexed.
    async fn wait_for_backfill_complete(&self, channel: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let done = self.cycles().iter().any(|cycle| {
                cycle["report"]["channels"]
                    .as_array()
                    .is_some_and(|channels| {
                        channels.iter().any(|c| {
                            c["channel"] == channel && c["backfillComplete"] == Value::Bool(true)
                        })
                    })
            });
            if done {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the backfill walk never completed for {channel}: {:?}",
                self.cycles()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn cycles(&self) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line["event"] == "search-agent-cycle")
            .cloned()
            .collect()
    }

    async fn stop(mut self) {
        let _ = self.child.kill().await;
    }
}

fn urlencode(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            other => format!("%{:02X}", other as u32),
        })
        .collect()
}

fn contents(results: &Value) -> Vec<String> {
    results["hits"]
        .as_array()
        .expect("hits array")
        .iter()
        .map(|hit| hit["content"].as_str().unwrap_or_default().to_string())
        .collect()
}

/// The world every test starts from: two encrypted channels provisioned by the
/// same admin, history in both, and a key wrapped to the agent for exactly one
/// of them.
async fn fixture(agent: &Keys, message_count: u64) -> (Fixture, RelayState, Keys) {
    let admin = Keys::generate();
    let relay = RelayState::default();
    let relay_url = spawn_relay(relay.clone()).await;
    let sidecar_url = spawn_sidecar(SidecarState {
        keys: agent.clone(),
    })
    .await;

    relay.publish(admin_list(&admin, MEMBER, &EPOCH0, 0, 1_700_000_000));
    relay.publish(admin_list(&admin, CONTROL, &CONTROL_KEY, 0, 1_700_000_000));

    // Enough history in the member channel to force the backfill walk to page.
    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "the deploy token is in the vault",
        1_700_000_100,
    ));
    for n in 0..message_count {
        relay.publish(sealed_message(
            &admin,
            MEMBER,
            &EPOCH0,
            &format!("routine standup note number {n}"),
            1_700_000_200 + n,
        ));
    }

    // The control channel is a real, populated, encrypted channel. The agent
    // is simply never given its key.
    relay.publish(sealed_message(
        &admin,
        CONTROL,
        &CONTROL_KEY,
        &format!("the {CONTROL_SECRET} deploy token is in the other vault"),
        1_700_000_150,
    ));

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

// ─── the acceptance criteria ─────────────────────────────────────────────────

/// Criterion 1: search returns results from an encrypted channel the agent is
/// a member of.
///
/// Also the paging proof: `--page-size 2` over eleven messages means the
/// backfill walk has to complete over several cycles, and every message must
/// end up searchable — a walk that dropped a page would show up as a missing
/// standup note.
#[tokio::test]
async fn an_encrypted_channel_the_agent_is_a_member_of_is_searchable() {
    let agent_keys = Keys::generate();
    let (fixture, _relay, _admin) = fixture(&agent_keys, 10).await;
    let agent = fixture.start_agent(2).await;

    // 1 headline message + 10 standup notes.
    let health = agent.wait_for_documents(11).await;
    assert_eq!(health["ok"], true);
    assert_eq!(
        health["channels"],
        json!([MEMBER]),
        "only the channel a key was wrapped for is tracked at all"
    );

    let results = agent.search("deploy token", &[MEMBER]).await;
    assert_eq!(results["found"], 1, "{results}");
    assert_eq!(
        contents(&results),
        vec!["the deploy token is in the vault"],
        "the plaintext of a NIP-44 sealed message comes back through search"
    );

    // Every paged-in message is searchable, not just the head page.
    let all = agent.search("standup", &[MEMBER]).await;
    assert_eq!(
        all["found"], 10,
        "the backfill walk must not drop a page: {all}"
    );

    // Typeahead: the trailing term is prefix-matched, as the desktop topbar
    // expects (`search_mode: "prefix"`).
    let partial = agent.search("depl", &[MEMBER]).await;
    assert_eq!(partial["found"], 1, "{partial}");

    let hit = &results["hits"][0];
    assert_eq!(hit["channelId"], MEMBER);
    assert_eq!(hit["kind"], 9);
    assert!(hit["eventId"].as_str().is_some_and(|id| id.len() == 64));

    agent.stop().await;
}

/// Criterion 2: content from channels the agent is NOT in never appears.
///
/// Three ways of asking, because the interesting failure is a filter applied
/// at the wrong layer: scoped to the member channel, scoped to the control
/// channel explicitly, and scoped to both at once.
#[tokio::test]
async fn a_channel_the_agent_is_not_in_never_appears_in_results() {
    let agent_keys = Keys::generate();
    let (fixture, _relay, _admin) = fixture(&agent_keys, 3).await;
    let agent = fixture.start_agent(50).await;

    agent.wait_for_documents(4).await;
    // Let the loop run again, so "not indexed yet" cannot be mistaken for
    // "never indexed".
    agent.wait_for_cycles(2).await;

    for scope in [
        vec![MEMBER],
        vec![CONTROL],
        vec![MEMBER, CONTROL],
        vec![MEMBER, CONTROL, "00000000-0000-0000-0000-000000000000"],
    ] {
        let results = agent.search(CONTROL_SECRET, &scope).await;
        assert_eq!(
            results["found"], 0,
            "the control channel's plaintext leaked with scope {scope:?}: {results}"
        );
    }

    // Not even the shared vocabulary reaches it: "deploy token" appears in both
    // channels, and only the member channel's copy is indexed.
    let shared = agent.search("deploy token", &[MEMBER, CONTROL]).await;
    assert_eq!(shared["found"], 1, "{shared}");
    assert_eq!(shared["hits"][0]["channelId"], MEMBER);

    // And the health surface never even names the control channel.
    let health = agent.get("/health").await;
    assert_eq!(health["channels"], json!([MEMBER]));

    // Membership-by-construction, restated: the agent holds one key.
    let keystore: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture.keystore()).unwrap()).unwrap();
    assert!(keystore["channels"][MEMBER].is_array());
    assert!(
        keystore["channels"][CONTROL].is_null(),
        "no key for the control channel is the entire access-control story"
    );

    agent.stop().await;
}

/// The privacy invariant's third case: a rotation the agent was excluded from
/// stops the index at the epoch boundary, and leaves what it could already
/// read intact (Slack-export semantics).
#[tokio::test]
async fn a_rotation_the_agent_missed_stops_the_index_at_the_epoch_boundary() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys, 2).await;
    let agent = fixture.start_agent(50).await;
    agent.wait_for_documents(3).await;

    // The admin removes the agent and rotates: a new epoch on the list, and a
    // new key wrapped to everyone still a member — which is nobody here. That
    // absence is the whole mechanism (buzz#19).
    relay.publish(admin_list(&admin, MEMBER, &EPOCH1, 1, 1_700_001_000));
    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH1,
        &format!("the {POST_ROTATION_SECRET} token replaced the old one"),
        1_700_001_100,
    ));

    // Two more cycles: one to see the rotation, one to prove it stays seen.
    let before = agent.cycles().len();
    agent.wait_for_cycles(before + 2).await;

    let leaked = agent.search(POST_ROTATION_SECRET, &[MEMBER]).await;
    assert_eq!(
        leaked["found"], 0,
        "post-rotation content must not be indexed: {leaked}"
    );

    // Nor is its ciphertext indexed under some other spelling: the document
    // count is unchanged, so nothing at all was stored for that event.
    let health = agent.get("/health").await;
    assert_eq!(
        health["documents"], 3,
        "the locked message added no document, not even a ciphertext one"
    );

    // What it could read before the rotation is still readable — the agent
    // already saw those bytes, and pretending otherwise would be theatre.
    let kept = agent.search("deploy token", &[MEMBER]).await;
    assert_eq!(kept["found"], 1, "{kept}");

    // The cycle report names the reason, so an operator can tell a lockout
    // from an empty channel.
    let last = agent.cycles().pop().expect("a cycle report");
    let channel = &last["report"]["channels"][0];
    assert_eq!(channel["channel"], MEMBER);
    assert!(
        channel["locked"].as_u64().unwrap_or(0) >= 1,
        "the report should say the message was locked: {last}"
    );

    agent.stop().await;
}

/// Criterion 3: an agent restart rebuilds or resumes the index from relay
/// history with no manual steps.
///
/// Both halves in one test, because they are the same code path seen from two
/// starting states — that is the design claim, and testing them apart would
/// hide it.
#[tokio::test]
async fn a_restart_resumes_from_the_cursor_and_a_missing_index_rebuilds() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys, 4).await;

    // ── first run ────────────────────────────────────────────────────────────
    let agent = fixture.start_agent(2).await;
    agent.wait_for_documents(5).await;
    agent.wait_for_backfill_complete(MEMBER).await;
    agent.stop().await;

    let index_on_disk: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture.index()).unwrap()).unwrap();
    assert_eq!(index_on_disk["version"], 1);
    let cursor = &index_on_disk["channels"][MEMBER];
    assert!(
        cursor["newestCreatedAt"].as_u64().is_some(),
        "the tail cursor is persisted alongside the documents: {index_on_disk}"
    );
    assert_eq!(
        cursor["backfillComplete"], true,
        "the backfill walk finished and said so: {index_on_disk}"
    );

    // ── restart: resume, do not re-ingest ───────────────────────────────────
    relay.publish(sealed_message(
        &admin,
        MEMBER,
        &EPOCH0,
        "posted while the agent was down",
        1_700_000_900,
    ));

    let agent = fixture.start_agent(2).await;
    agent.wait_for_documents(6).await;

    let resumed = agent.search("posted while", &[MEMBER]).await;
    assert_eq!(
        resumed["found"], 1,
        "a message written while the agent was down is picked up on restart: {resumed}"
    );
    // Still there from before the restart — the index was resumed, not reset.
    assert_eq!(agent.search("deploy token", &[MEMBER]).await["found"], 1);

    let first_cycle = agent.cycles().into_iter().next().expect("a cycle report");
    assert_eq!(
        first_cycle["report"]["indexed"], 1,
        "resuming from the cursor means only the new message is indexed, \
         not the whole channel again: {first_cycle}"
    );
    agent.stop().await;

    // ── delete the index: rebuild from relay history, no manual steps ───────
    std::fs::remove_file(fixture.index()).unwrap();
    let agent = fixture.start_agent(2).await;
    agent.wait_for_documents(6).await;
    agent.wait_for_backfill_complete(MEMBER).await;

    assert_eq!(agent.search("deploy token", &[MEMBER]).await["found"], 1);
    assert_eq!(agent.search("standup", &[MEMBER]).await["found"], 4);
    assert_eq!(agent.search("posted while", &[MEMBER]).await["found"], 1);
    let rebuilt = agent.cycles().into_iter().next().expect("a cycle report");
    assert!(
        rebuilt["report"]["indexed"].as_u64().unwrap_or(0) >= 1,
        "a missing index is a first run, and a first run rebuilds: {rebuilt}"
    );

    agent.stop().await;
}

/// The tail walk must survive more new messages arriving between cycles than
/// one page holds. A `since`-only poll would jump the cursor to the newest and
/// strand the middle of the burst forever; this is the regression guard.
#[tokio::test]
async fn a_burst_larger_than_one_page_is_indexed_without_gaps() {
    let agent_keys = Keys::generate();
    let (fixture, relay, admin) = fixture(&agent_keys, 0).await;

    let agent = fixture.start_agent(3).await;
    agent.wait_for_documents(1).await;

    // Twelve messages at once, four times the page size.
    for n in 0..12u64 {
        relay.publish(sealed_message(
            &admin,
            MEMBER,
            &EPOCH0,
            &format!("burst message number {n}"),
            1_700_002_000 + n,
        ));
    }

    agent.wait_for_documents(13).await;
    let burst = agent.search("burst message", &[MEMBER]).await;
    assert_eq!(
        burst["found"], 12,
        "every message in the burst must be indexed, not just the newest page: {burst}"
    );

    agent.stop().await;
}
