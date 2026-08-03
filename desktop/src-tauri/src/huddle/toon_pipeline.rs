//! TOON huddle audio pipeline (buzz#23 stage 2, ADR 0003).
//!
//! On the TOON transport there is no audio room. This module replaces
//! [`super::relay_api::connect_audio_relay`] when `BUZZ_TRANSPORT=toon`:
//!
//! ```text
//! send:  pcm_rx → Opus encode → SpeechGate → build_frame_event (seals for
//!        keyed channels, signs) → event_transport::dispatch — one paid
//!        write per ~20 ms frame, bounded in-flight, drop-late
//! recv:  free NIP-01 WS subscription (kinds:[24820], #h-scoped) →
//!        verify-before-attribute → parse_frame_event → SpeakerSlots →
//!        per-peer NetEq jitter buffer → per-peer rodio Player
//! ```
//!
//! The send side pays (via the frontend's `ToonPaidWriter`, reached through
//! the `event_transport` bridge — Rust has no payment client); the receive
//! side is free, so it dials the TOON relay's WebSocket directly rather than
//! going anywhere near the paid seam.
//!
//! Design points, each pinned by the buzz#10 measurements:
//!
//! - **Drop-late, never burst.** A real microphone produces one frame per
//!   20 ms of wall clock. If publishing stalls, the late frames are dropped
//!   ([`MAX_IN_FLIGHT_FRAMES`]); catching up with a burst would inject our
//!   own queueing delay into the edge and arrive too late to play anyway.
//! - **DTX off, gate on.** The legacy room keeps Opus DTX because comfort
//!   packets are free over a plain WebSocket. Here every packet is a paid
//!   write, so the [`SpeechGate`] replaces DTX outright: silence publishes —
//!   and pays — nothing at all.
//! - **Rejoin = fresh `since`.** Frames are ephemeral (never stored), so a
//!   dropped subscription reconnects into the live stream and accepts the
//!   gap — there is nothing to replay.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use nostr::JsonUtil;
use tauri::Manager;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMsg};
use tokio_util::sync::CancellationToken;

use crate::app_state::AppState;

use super::jitter::{PeerJitterBuffer, FRAME_TIMESTAMP_DELTA, SAMPLE_RATE_HZ};
use super::relay_api::REMOTE_SPEECH_THRESHOLD;
use super::speaker_slots::SpeakerSlots;
use super::toon_frames::{self, FrameParseError};
use super::vad::SpeechGate;
use super::wire::{audio_level_dbov, FrameHeader};

/// Default TOON relay WebSocket. Mirrors `TOON_DEVNET_DEFAULTS.relayUrl` in
/// `shared/api/toonTransportConfig.ts` — `relay-ws`, not `relay`, which is
/// parked DNS.
const DEFAULT_TOON_RELAY_URL: &str = "wss://relay-ws.devnet.toonprotocol.dev";

/// Paid writes allowed in flight at once. A frame that would exceed this is
/// dropped (drop-late): the measured devnet RTT is ~65–100 ms, so 8 × 20 ms
/// of budget covers normal jitter, while a real stall (connector hiccup,
/// settlement pause) sheds frames instead of building a delay queue the
/// listener would hear as ever-growing latency.
const MAX_IN_FLIGHT_FRAMES: usize = 8;

/// How far back the first subscription looks. Frames are ephemeral, so this
/// only smooths the connect race — it can never replay history.
const SUBSCRIBE_LOOKBACK_SECS: u64 = 5;

/// Delay between reconnect attempts of the free subscription.
const RECONNECT_BACKOFF: std::time::Duration = std::time::Duration::from_secs(1);

/// Playout clock: NetEq emits 10 ms frames (same as `playout.rs`).
const PLAYOUT_TICK_MS: u64 = 10;

/// Window for the `huddle-active-speakers` emission (same as `playout.rs`).
const SPEAKER_TICK_MS: u64 = 500;

/// Grace past the last received frame during which we keep draining a
/// speaker's NetEq into their Player (same reasoning as `playout.rs`).
const IDLE_PEER_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// Drift bound on per-peer rodio Player queue depth (same as `playout.rs`).
const PLAYOUT_QUEUE_HIGH_WATER: usize = 4;

/// Forget a speaker (drop their jitter buffer + Player, free their slot)
/// after this much silence. There is no `left` roster message on TOON — a
/// speaker who leaves simply stops publishing — so slot reclamation is time
/// based. Long enough that a muted-but-present member re-entering speech gets
/// a fresh NetEq rather than one with minutes-stale delay state.
const SPEAKER_EVICT_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

/// The TOON relay WebSocket URL for free reads, from the same env key the
/// frontend reads (`BUZZ_TOON_RELAY_URL`), with the devnet default.
fn toon_relay_ws_url() -> String {
    crate::relay::configured_env_var("BUZZ_TOON_RELAY_URL")
        .unwrap_or_else(|| DEFAULT_TOON_RELAY_URL.to_string())
}

/// The NIP-01 REQ for a huddle's frame stream: ephemeral frame kind, scoped
/// to the huddle's channel by `#h`, from `since` onward.
fn subscription_req(channel_id: &str, since: u64) -> String {
    serde_json::json!([
        "REQ",
        "huddle-frames",
        {
            "kinds": [toon_frames::FRAME_KIND],
            "#h": [channel_id],
            "since": since,
        }
    ])
    .to_string()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Extract the event payload from a relay `EVENT` message, tolerating the
/// devnet relay's double-encoding gotcha: the third element arrives either as
/// the event object itself or as a JSON *string containing* the event JSON.
/// Returns the event's own JSON text, or `None` for anything that is not an
/// EVENT message (EOSE, NOTICE, junk).
fn extract_event_json(raw: &str) -> Option<String> {
    let msg: serde_json::Value = serde_json::from_str(raw).ok()?;
    let arr = msg.as_array()?;
    if arr.first()?.as_str()? != "EVENT" {
        return None;
    }
    let payload = arr.get(2)?;
    match payload {
        // Double-encoded (the devnet shape): the payload is a string of JSON.
        serde_json::Value::String(inner) => Some(inner.clone()),
        serde_json::Value::Object(_) => Some(payload.to_string()),
        _ => None,
    }
}

/// Connect the TOON huddle audio pipeline for `channel_id`.
///
/// Returns the same `(cancel_token, pcm_sender)` contract as
/// [`super::relay_api::connect_audio_relay`], so `HuddleState`, teardown
/// (`teardown_huddle` cancels the token and drops the sender — frames stop
/// the moment the user leaves), and audio reconnect all work unchanged.
///
/// The initial subscription WebSocket is dialed before this returns, so a
/// dead relay fails the join the same way a dead audio room does.
pub(crate) async fn connect_toon_audio(
    channel_id: &str,
    state: &AppState,
) -> Result<(CancellationToken, tokio::sync::mpsc::Sender<Vec<u8>>), String> {
    let keys = state.keys.lock().map_err(|e| e.to_string())?.clone();
    let app_handle = state
        .app_handle
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("toon huddle: app handle not available yet")?;

    let (tts_cancel, tts_active) = {
        let hs = state.huddle()?;
        (Arc::clone(&hs.tts_cancel), Arc::clone(&hs.tts_active))
    };

    let relay_url = toon_relay_ws_url();
    let (ws_stream, _) = connect_async(&relay_url)
        .await
        .map_err(|e| format!("toon relay WS connect failed: {e}"))?;

    let output_device_name = state
        .audio_output_device
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let sink_handle = super::audio_output::open_output_sink_by_name(output_device_name.as_deref())?;

    let cancel = CancellationToken::new();
    let (pcm_tx, pcm_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(50);

    let send_task = tokio::spawn(toon_send_loop(SendLoopArgs {
        pcm_rx,
        cancel: cancel.clone(),
        app_handle: app_handle.clone(),
        keys: keys.clone(),
        channel_id: channel_id.to_string(),
        // The bridge transport ignores this (its destination is the
        // frontend's active TOON config), but the seam's contract wants the
        // relay-mode URL — and a misrouted dispatch should fail loudly at a
        // real endpoint rather than at an empty string.
        api_url: format!(
            "{}/events",
            crate::relay::relay_api_base_url_with_override(state)
        ),
    }));

    let recv_task = tokio::spawn(toon_recv_loop(RecvLoopArgs {
        ws_stream: Some(ws_stream),
        relay_url,
        channel_id: channel_id.to_string(),
        own_pubkey: keys.public_key().to_hex(),
        cancel: cancel.clone(),
        app_handle: app_handle.clone(),
        sink_handle,
        tts_active,
        tts_cancel,
    }));

    let cancel_watch = cancel.clone();
    tokio::spawn(async move {
        // Wait for either half to finish, then abort the survivor — the same
        // supervision shape as `relay_api::audio_relay_pipeline`.
        use futures_util::future::Either;
        match futures_util::future::select(std::pin::pin!(send_task), std::pin::pin!(recv_task))
            .await
        {
            Either::Left((_, recv_handle)) => recv_handle.abort(),
            Either::Right((_, send_handle)) => send_handle.abort(),
        }

        // Only emit the disconnect event for UNEXPECTED exits — teardown has
        // already cancelled the token on an intentional leave.
        if !cancel_watch.is_cancelled() {
            cancel_watch.cancel();
            use tauri::Emitter;
            let _ = app_handle.emit("huddle-audio-disconnected", ());
        }
    });

    Ok((cancel, pcm_tx))
}

struct SendLoopArgs {
    pcm_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    cancel: CancellationToken,
    app_handle: tauri::AppHandle,
    keys: nostr::Keys,
    channel_id: String,
    api_url: String,
}

/// PCM → encode → gate → sign/seal → paid write, one event per frame.
async fn toon_send_loop(args: SendLoopArgs) {
    let SendLoopArgs {
        mut pcm_rx,
        cancel,
        app_handle,
        keys,
        channel_id,
        api_url,
    } = args;

    const FRAME_SAMPLES: usize = 960;

    let mut encoder = match opus::Encoder::new(48000, opus::Channels::Mono, opus::Application::Voip)
    {
        Ok(e) => e,
        Err(e) => {
            eprintln!("buzz-desktop: toon huddle opus encoder: {e}");
            return;
        }
    };
    if let Err(e) = encoder.set_bitrate(opus::Bitrate::Bits(32000)) {
        eprintln!("buzz-desktop: toon huddle opus bitrate: {e}");
        return;
    }
    // DTX off: the speech gate replaces it. A DTX comfort packet would be a
    // *paid* packet saying "silence" — exactly what the gate exists to elide.
    if let Err(e) = encoder.set_dtx(false) {
        eprintln!("buzz-desktop: toon huddle opus dtx: {e}");
        return;
    }

    let mut gate = SpeechGate::default();
    let mut out_buf = vec![0u8; 4000];
    // Sender-authored wire state. `ts_48k` advances with *captured* media
    // time (gated frames included) so the receiver's NetEq sees the true gap
    // a closed gate leaves; `seq` advances only per published packet so loss
    // detection isn't fooled by silence.
    let mut seq: u16 = 0;
    let mut ts_48k: u32 = 0;

    let in_flight = Arc::new(AtomicUsize::new(0));
    let mut dropped_late: u64 = 0;
    let publish_failures = Arc::new(AtomicUsize::new(0));

    loop {
        let pcm_bytes = {
            use futures_util::future::Either;
            let cancelled = std::pin::pin!(cancel.cancelled());
            let recv = std::pin::pin!(pcm_rx.recv());
            match futures_util::future::select(cancelled, recv).await {
                Either::Left(_) => break, // Cancelled — the user left.
                Either::Right((Some(b), _)) => b,
                Either::Right((None, _)) => break, // Sender dropped (teardown).
            }
        };

        if pcm_bytes.len() % 4 != 0 {
            continue; // Malformed batch.
        }
        let samples: Vec<f32> = pcm_bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();

        for chunk in samples.chunks(FRAME_SAMPLES) {
            let level = audio_level_dbov(chunk);
            let frame_ts = ts_48k;
            ts_48k = ts_48k.wrapping_add(FRAME_TIMESTAMP_DELTA);

            // The gate must see every frame's level in capture order — its
            // hangover state is what keeps word endings from clipping.
            if !gate.should_publish(level) {
                continue; // Silence publishes (and pays) nothing.
            }

            let encode_result = if chunk.len() == FRAME_SAMPLES {
                encoder.encode_float(chunk, &mut out_buf)
            } else {
                let mut padded = chunk.to_vec();
                padded.resize(FRAME_SAMPLES, 0.0);
                encoder.encode_float(&padded, &mut out_buf)
            };
            let n = match encode_result {
                Ok(n) if n > 0 => n,
                Ok(_) => continue,
                Err(e) => {
                    eprintln!("buzz-desktop: toon huddle opus encode: {e}");
                    continue;
                }
            };

            let header = FrameHeader {
                seq,
                ts_48k: frame_ts,
                level_dbov: level,
                flags: 0, // Never DTX here — the gate already elided silence.
            };
            let event =
                match toon_frames::build_frame_event(&channel_id, header, &out_buf[..n], &keys) {
                    Ok(event) => event,
                    Err(e) => {
                        eprintln!("buzz-desktop: toon huddle frame build: {e}");
                        continue;
                    }
                };
            seq = seq.wrapping_add(1);

            // Drop-late: a frame that cannot start now is worthless by the
            // time the backlog clears, and bursting the backlog would turn a
            // stall into audible added latency (see the module doc).
            if in_flight.load(Ordering::Acquire) >= MAX_IN_FLIGHT_FRAMES {
                dropped_late += 1;
                if dropped_late.is_power_of_two() {
                    eprintln!(
                        "buzz-desktop: toon huddle dropped {dropped_late} late frame(s) \
                         (publish backlog at {MAX_IN_FLIGHT_FRAMES})",
                    );
                }
                continue;
            }

            in_flight.fetch_add(1, Ordering::AcqRel);
            let in_flight = Arc::clone(&in_flight);
            let failures = Arc::clone(&publish_failures);
            let app_handle = app_handle.clone();
            let keys = keys.clone();
            let cancel = cancel.clone();
            let api_url = api_url.clone();
            tokio::spawn(async move {
                let body = event.as_json().into_bytes();
                let state = app_handle.state::<AppState>();
                let submission = crate::event_transport::SignedEventSubmission {
                    body: &body,
                    api_url,
                    keys: &keys,
                    auth_tag: None,
                    context: "huddle TOON frame publish",
                };
                let dispatched = tokio::select! {
                    result = crate::event_transport::dispatch(&state, submission) => Some(result),
                    // The user left: stop accounting for this write. The
                    // event is already handed off; nothing new is sent.
                    _ = cancel.cancelled() => None,
                };
                if let Some(Err(e)) = dispatched {
                    let count = failures.fetch_add(1, Ordering::AcqRel) + 1;
                    if count.is_power_of_two() {
                        eprintln!(
                            "buzz-desktop: toon huddle frame publish failed ({count} so far): {e}"
                        );
                    }
                }
                in_flight.fetch_sub(1, Ordering::AcqRel);
            });
        }
    }
}

/// One remote speaker's playout slot: jitter buffer + dedicated rodio
/// Player (mirrors `playout.rs::PeerSlot`, keyed by [`SpeakerSlots`] instead
/// of the relay's `peer_index`).
struct ToonPeerSlot {
    jitter: PeerJitterBuffer,
    player: rodio::Player,
    last_packet_at: tokio::time::Instant,
}

impl ToonPeerSlot {
    fn new(slot: u8, sink_mixer: &rodio::mixer::Mixer) -> Option<Self> {
        match PeerJitterBuffer::new(slot) {
            Ok(jitter) => Some(Self {
                jitter,
                player: rodio::Player::connect_new(sink_mixer),
                last_packet_at: tokio::time::Instant::now(),
            }),
            Err(e) => {
                eprintln!("buzz-desktop: toon huddle jitter buffer init slot {slot}: {e}");
                None
            }
        }
    }

    fn is_active(&self) -> bool {
        self.last_packet_at.elapsed() < IDLE_PEER_GRACE || !self.jitter.is_empty()
    }
}

struct RecvLoopArgs {
    /// The already-dialed first connection (so a dead relay fails the join).
    ws_stream: Option<super::relay_api::WsStream>,
    relay_url: String,
    channel_id: String,
    own_pubkey: String,
    cancel: CancellationToken,
    app_handle: tauri::AppHandle,
    sink_handle: rodio::MixerDeviceSink,
    tts_active: Arc<AtomicBool>,
    tts_cancel: Arc<AtomicBool>,
}

/// Free subscription → verify → parse → jitter buffer → playout.
async fn toon_recv_loop(args: RecvLoopArgs) {
    use rodio::buffer::SamplesBuffer;
    use std::num::NonZero;
    use tauri::Emitter;

    let RecvLoopArgs {
        mut ws_stream,
        relay_url,
        channel_id,
        own_pubkey,
        cancel,
        app_handle,
        sink_handle,
        tts_active,
        tts_cancel,
    } = args;

    let channels = NonZero::new(1u16).expect("1 is non-zero");
    let rate = NonZero::new(SAMPLE_RATE_HZ).expect("48k is non-zero");

    let mut slots = SpeakerSlots::new();
    let mut peers: HashMap<u8, ToonPeerSlot> = HashMap::new();
    let mut slot_pubkeys: HashMap<u8, String> = HashMap::new();
    let mut active_pubkeys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut frame_counts: HashMap<u8, u16> = HashMap::new();
    let mut last_frame_reset = tokio::time::Instant::now();
    let mut tts_was_active = false;
    let mut undecryptable_seen = false;

    let mut playout_tick = tokio::time::interval(std::time::Duration::from_millis(PLAYOUT_TICK_MS));
    // `Delay`, not `Skip`: a dropped playout tick is 10 ms of audible silence
    // (see `playout.rs` for the full reasoning).
    playout_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut speaker_tick = tokio::time::interval(std::time::Duration::from_millis(SPEAKER_TICK_MS));
    speaker_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Outer reconnect loop: frames are ephemeral, so every (re)subscription
    // starts from a fresh `since` and accepts the gap — AC 3 on buzz#23.
    'reconnect: loop {
        let stream = match ws_stream.take() {
            Some(s) => s,
            None => {
                tokio::select! {
                    _ = cancel.cancelled() => break 'reconnect,
                    _ = tokio::time::sleep(RECONNECT_BACKOFF) => {}
                }
                match connect_async(&relay_url).await {
                    Ok((s, _)) => s,
                    Err(e) => {
                        eprintln!("buzz-desktop: toon huddle resubscribe failed: {e}");
                        continue 'reconnect;
                    }
                }
            }
        };
        let (mut ws_tx, mut ws_rx) = stream.split();

        let since = unix_now().saturating_sub(SUBSCRIBE_LOOKBACK_SECS);
        if let Err(e) = ws_tx
            .send(WsMsg::Text(subscription_req(&channel_id, since).into()))
            .await
        {
            eprintln!("buzz-desktop: toon huddle REQ send failed: {e}");
            continue 'reconnect;
        }

        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break 'reconnect,
                _ = playout_tick.tick() => {
                    for (slot, peer) in peers.iter_mut() {
                        if !peer.is_active() {
                            // Keep NetEq's clock advancing without pumping
                            // silence buffers into rodio for idle speakers.
                            let _ = peer.jitter.get_audio();
                            continue;
                        }
                        match peer.jitter.get_audio() {
                            Ok((samples, _vad)) => {
                                if peer.player.len() >= PLAYOUT_QUEUE_HIGH_WATER {
                                    peer.player.skip_one();
                                }
                                peer.player.append(SamplesBuffer::new(channels, rate, samples));
                            }
                            Err(e) => {
                                eprintln!("buzz-desktop: toon huddle get_audio slot {slot}: {e}");
                            }
                        }
                    }
                }
                _ = speaker_tick.tick() => {
                    let pubkeys: Vec<String> = active_pubkeys.iter().cloned().collect();
                    let _ = app_handle.emit("huddle-active-speakers", &pubkeys);
                    active_pubkeys.clear();

                    // Time-based slot reclamation — there is no `left` message
                    // on TOON, a departed speaker simply stops publishing.
                    let evict: Vec<(u8, String)> = slot_pubkeys
                        .iter()
                        .filter(|(slot, _)| {
                            peers
                                .get(*slot)
                                .is_some_and(|p| p.last_packet_at.elapsed() >= SPEAKER_EVICT_AFTER)
                        })
                        .map(|(slot, pubkey)| (*slot, pubkey.clone()))
                        .collect();
                    for (slot, pubkey) in evict {
                        peers.remove(&slot);
                        frame_counts.remove(&slot);
                        slot_pubkeys.remove(&slot);
                        slots.release(&pubkey);
                    }
                }
                msg = ws_rx.next() => {
                    match msg {
                        Some(Ok(WsMsg::Text(text))) => {
                            let Some(event_json) = extract_event_json(&text) else {
                                continue; // EOSE/NOTICE/etc.
                            };
                            // Verify BEFORE attributing: an unsigned frame
                            // must never select a playout slot or light up a
                            // speaker tile.
                            let Some(event) = toon_frames::verified_event_from_json(&event_json)
                            else {
                                continue;
                            };
                            let pubkey = event.pubkey.to_hex();
                            if pubkey == own_pubkey {
                                continue; // Our own frames echo back on the relay.
                            }
                            let parsed = match toon_frames::parse_frame_event(&event, &channel_id) {
                                Ok(parsed) => parsed,
                                Err(FrameParseError::Undecryptable) => {
                                    // Expected for a non-member or a key-sync
                                    // race after rotation — log once, not 50×/s.
                                    if !undecryptable_seen {
                                        undecryptable_seen = true;
                                        eprintln!(
                                            "buzz-desktop: toon huddle: sealed frames this \
                                             client holds no channel key for (dropping)",
                                        );
                                    }
                                    continue;
                                }
                                Err(_) => continue,
                            };

                            let Some(slot) = slots.slot_for(&pubkey) else {
                                continue; // All 255 slots busy — drop, never evict.
                            };
                            slot_pubkeys.entry(slot).or_insert_with(|| pubkey.clone());
                            active_pubkeys.insert(pubkey);

                            // TTS interrupt frame counter — reset on TTS rising
                            // edge (mirrors `playout.rs`; every TOON frame is
                            // real speech, the gate already removed silence).
                            let tts_now = tts_active.load(Ordering::Acquire);
                            if tts_now && !tts_was_active {
                                frame_counts.clear();
                                last_frame_reset = tokio::time::Instant::now();
                            }
                            tts_was_active = tts_now;

                            let peer = match peers.entry(slot) {
                                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                                std::collections::hash_map::Entry::Vacant(e) => {
                                    let Some(peer) = ToonPeerSlot::new(slot, sink_handle.mixer())
                                    else {
                                        continue;
                                    };
                                    e.insert(peer)
                                }
                            };

                            if let Err(err) = peer.jitter.insert_packet(
                                parsed.header.seq,
                                parsed.header.ts_48k,
                                &parsed.opus_payload,
                            ) {
                                eprintln!("buzz-desktop: toon huddle jitter insert slot {slot}: {err}");
                            } else {
                                peer.last_packet_at = tokio::time::Instant::now();
                            }

                            if tts_now {
                                if last_frame_reset.elapsed()
                                    >= std::time::Duration::from_millis(SPEAKER_TICK_MS)
                                {
                                    frame_counts.clear();
                                    last_frame_reset = tokio::time::Instant::now();
                                }
                                let count = frame_counts.entry(slot).or_insert(0);
                                *count = count.saturating_add(1);
                                if *count >= REMOTE_SPEECH_THRESHOLD {
                                    tts_cancel.store(true, Ordering::Release);
                                }
                            }
                        }
                        Some(Ok(WsMsg::Ping(data))) => {
                            let _ = ws_tx.send(WsMsg::Pong(data)).await;
                        }
                        Some(Ok(WsMsg::Close(_))) | None | Some(Err(_)) => {
                            // Dropped subscription: resubscribe with a fresh
                            // `since`, accepting the gap (ephemeral = no replay).
                            continue 'reconnect;
                        }
                        Some(Ok(_)) => {} // Binary frames are not part of NIP-01.
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_event_json, subscription_req};

    #[test]
    fn the_req_scopes_to_the_frame_kind_and_channel() {
        let req = subscription_req("chan-1", 1_750_000_000);
        let parsed: serde_json::Value = serde_json::from_str(&req).expect("REQ is JSON");
        assert_eq!(parsed[0], "REQ");
        assert_eq!(
            parsed[2]["kinds"],
            serde_json::json!([super::toon_frames::FRAME_KIND])
        );
        assert_eq!(parsed[2]["#h"], serde_json::json!(["chan-1"]));
        assert_eq!(parsed[2]["since"], serde_json::json!(1_750_000_000u64));
    }

    #[test]
    fn extracts_a_plain_event_payload() {
        let raw = r#"["EVENT","huddle-frames",{"id":"abc","kind":24820}]"#;
        let json = extract_event_json(raw).expect("plain payload");
        let event: serde_json::Value = serde_json::from_str(&json).expect("payload is JSON");
        assert_eq!(event["id"], "abc");
    }

    #[test]
    fn extracts_a_double_encoded_event_payload() {
        // The devnet relay serves EVENT payloads as a JSON string containing
        // the event JSON — a naive reader sees a string and reports the event
        // missing. See the relay-event-double-encoded gotcha.
        let raw = r#"["EVENT","huddle-frames","{\"id\":\"abc\",\"kind\":24820}"]"#;
        let json = extract_event_json(raw).expect("double-encoded payload");
        let event: serde_json::Value = serde_json::from_str(&json).expect("inner JSON");
        assert_eq!(event["id"], "abc");
        assert_eq!(event["kind"], 24820);
    }

    #[test]
    fn non_event_messages_are_ignored() {
        assert_eq!(extract_event_json(r#"["EOSE","huddle-frames"]"#), None);
        assert_eq!(extract_event_json(r#"["NOTICE","slow down"]"#), None);
        assert_eq!(extract_event_json(r#"["EVENT","sub",42]"#), None);
        assert_eq!(extract_event_json("not json at all"), None);
        assert_eq!(extract_event_json(r#"{"type":"challenge"}"#), None);
    }

    #[test]
    fn a_verified_frame_round_trips_through_the_receive_parse_chain() {
        // The exact chain the receive loop runs: raw relay text →
        // extract_event_json → verified_event_from_json → parse_frame_event.
        use crate::channel_keys::channel_keys_test_lock;
        use nostr::JsonUtil;

        let _guard = channel_keys_test_lock();
        crate::channel_keys::sync_keys(std::collections::HashMap::new());

        let keys = nostr::Keys::generate();
        let header = super::FrameHeader {
            seq: 7,
            ts_48k: 7 * 960,
            level_dbov: -30,
            flags: 0,
        };
        let event = super::toon_frames::build_frame_event("chan-9", header, &[1, 2, 3], &keys)
            .expect("build frame");

        // Simulate the devnet's double-encoded delivery.
        let raw = serde_json::json!(["EVENT", "huddle-frames", event.as_json()]).to_string();
        let json = extract_event_json(&raw).expect("payload");
        let verified = super::toon_frames::verified_event_from_json(&json).expect("verifies");
        let parsed = super::toon_frames::parse_frame_event(&verified, "chan-9").expect("parses");
        assert_eq!(parsed.header, header);
        assert_eq!(parsed.opus_payload, vec![1, 2, 3]);
    }
}
