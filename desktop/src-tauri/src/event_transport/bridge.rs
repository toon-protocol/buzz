//! The TOON bridge: Rust has no payment client, so a Rust-side write asks the
//! frontend's already-active transport to carry it.
//!
//! Rust signs and guards the event, then emits `BRIDGE_REQUEST_EVENT` with
//! the raw event JSON and waits (via a oneshot channel keyed by a request id,
//! held in the module-level `PENDING` map — this bridge's book-keeping is
//! process-global rather than threaded through `AppState`, since it is
//! entirely internal to this file) for `report_bridged_write_result` — a
//! Tauri command the frontend's `installRustWriteBridge()`
//! (`shared/api/rustWriteBridge.ts`) calls after it hands the event to
//! `getEventTransport().publish(...)`. That is the exact seam TS writes
//! already go through, so whichever transport TS selected — relay or TOON —
//! is what a bridged Rust write rides too, and already-encrypted channel
//! content (buzz#12 encrypts *above* the TS seam) passes through untouched:
//! this bridge only ever carries opaque signed-event bytes.
//!
//! # Known limitations (v1, documented rather than fixed)
//!
//! - **Pre-render race.** A write attempted before the frontend has called
//!   `installRustWriteBridge()` is emitted into the void: nothing is
//!   listening yet, so it times out rather than publishing. In practice
//!   every Rust write site fires from a user action taken well after the
//!   window is up; the one exception is launch-time managed-agent profile
//!   reconcile, which already tolerates and reports a sync failure
//!   (`profile_sync_error` on the import result) rather than assuming success.
//! - **Explicit non-workspace relay targets are ignored.** See
//!   [`super::SignedEventSubmission::api_url`].
//! - **Payment cost is invisible here.** The frontend's `ToonEventTransport`
//!   already surfaces fee information via `onPaidWrite`; this bridge does not
//!   thread it back to the Rust caller. A future iteration could report it
//!   alongside the accept/reject outcome.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::oneshot;

use super::{EventTransport, SignedEventSubmission};
use crate::app_state::AppState;
use crate::relay::SubmitEventResponse;

/// Tauri event the frontend listens for (`installRustWriteBridge` in
/// `shared/api/rustWriteBridge.ts`). Payload is `BridgeWriteRequest`.
const BRIDGE_REQUEST_EVENT: &str = "buzz://rust-write-bridge-request";

/// How long to wait for the frontend to report a result before giving up.
/// Deliberately longer than the frontend's own publish timeout
/// (`PUBLISH_TIMEOUT_MS`, 25s) so a real publish timeout surfaces the
/// frontend's specific message rather than this generic one.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);

type BridgeWriteSender = oneshot::Sender<Result<(), String>>;

/// Writes awaiting `report_bridged_write_result`. One process-wide instance —
/// there is exactly one webview to bridge through — rather than a field on
/// `AppState`: nothing outside this file ever needs to reach it.
static PENDING: LazyLock<Mutex<HashMap<String, BridgeWriteSender>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeWriteRequest {
    request_id: String,
    event_json: String,
}

/// The seam's TOON implementation. See the module doc for the full contract.
pub struct BridgeTransport;

#[async_trait::async_trait]
impl EventTransport for BridgeTransport {
    async fn submit(
        &self,
        state: &AppState,
        submission: SignedEventSubmission<'_>,
    ) -> Result<SubmitEventResponse, String> {
        let app = state
            .app_handle
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| {
                "toon transport: no window to bridge the write through yet".to_string()
            })?;

        let event_json = String::from_utf8(submission.body.to_vec())
            .map_err(|e| format!("toon transport: signed event was not valid UTF-8: {e}"))?;

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
            pending.insert(request_id.clone(), tx);
        }

        if let Err(err) = app.emit(
            BRIDGE_REQUEST_EVENT,
            BridgeWriteRequest {
                request_id: request_id.clone(),
                event_json,
            },
        ) {
            remove_pending(&request_id);
            return Err(format!(
                "toon transport: could not reach the frontend bridge: {err}"
            ));
        }

        let outcome = match tokio::time::timeout(BRIDGE_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                Err("toon transport: bridge listener was dropped before it could reply".to_string())
            }
            Err(_) => {
                remove_pending(&request_id);
                Err("toon transport: timed out waiting for the frontend to publish".to_string())
            }
        };

        outcome.map(|()| SubmitEventResponse {
            event_id: extract_event_id(submission.body),
            accepted: true,
            message: "published via the bridged TOON transport".to_string(),
        })
    }
}

fn remove_pending(request_id: &str) {
    if let Ok(mut pending) = PENDING.lock() {
        pending.remove(request_id);
    }
}

/// Best-effort `id` extraction for the response's `event_id` — cosmetic only.
/// Callers that need the id already have it, from the `nostr::Event` they
/// signed before serializing; an empty string on parse failure never blocks
/// the outcome itself.
fn extract_event_id(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("id").and_then(|id| id.as_str().map(str::to_string)))
        .unwrap_or_default()
}

/// Resolve a pending bridged write. Called by the `report_bridged_write_result`
/// Tauri command once the frontend has attempted the publish.
pub(crate) fn resolve_pending(request_id: &str, error: Option<String>) -> Result<(), String> {
    let sender = PENDING
        .lock()
        .map_err(|e| e.to_string())?
        .remove(request_id);
    let Some(sender) = sender else {
        return Err(format!("no pending bridged write for request {request_id}"));
    };
    // The receiving `submit()` call may already have timed out and moved on;
    // a dropped receiver here just means that future's `Err` case fires
    // instead, which is already a defined, non-panicking outcome.
    let _ = sender.send(match error {
        Some(message) => Err(message),
        None => Ok(()),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{extract_event_id, resolve_pending};

    #[test]
    fn extracts_id_from_well_formed_event_json() {
        let body = br#"{"id":"abc123","pubkey":"x","created_at":1,"kind":1,"tags":[],"content":"","sig":"y"}"#;
        assert_eq!(extract_event_id(body), "abc123");
    }

    #[test]
    fn returns_empty_string_for_malformed_json() {
        assert_eq!(extract_event_id(b"not json"), "");
    }

    #[test]
    fn returns_empty_string_when_id_field_is_missing() {
        assert_eq!(extract_event_id(br#"{"pubkey":"x"}"#), "");
    }

    #[test]
    fn resolving_an_unknown_request_id_is_an_error_not_a_panic() {
        let err = resolve_pending("does-not-exist-buzz27-bridge-test", None).unwrap_err();
        assert!(err.contains("does-not-exist-buzz27-bridge-test"), "{err}");
    }
}
