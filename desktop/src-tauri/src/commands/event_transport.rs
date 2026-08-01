//! Tauri command for the TOON write bridge (`event_transport::bridge`).

/// The frontend's report of what happened to a bridged write it was asked to
/// publish (`installRustWriteBridge` in `shared/api/rustWriteBridge.ts`).
/// Resolves the Rust-side caller waiting on `BridgeTransport::submit`.
///
/// `error: None` means the frontend's `getEventTransport().publish(...)`
/// resolved; `Some(message)` means it rejected or threw, and `message` is
/// surfaced as the Rust caller's error.
#[tauri::command]
pub fn report_bridged_write_result(
    request_id: String,
    error: Option<String>,
) -> Result<(), String> {
    crate::event_transport::resolve_pending(&request_id, error)
}
