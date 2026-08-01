//! Tauri command for the channel-key sync (buzz#33).

use std::collections::HashMap;

/// Replace Rust's copy of the channel-key map with the frontend's current
/// one. The frontend (`channelKeySync.ts`) calls this once at startup and
/// again on every `subscribeToChannelKeys` notification — the same "push on
/// every change" shape `installRustWriteBridge` uses for the transport seam,
/// just in the other direction (frontend → Rust instead of Rust → frontend).
///
/// `keys` is `{ channelId: hexKey }`, the same record shape
/// `channelKeyStore.ts` persists to `localStorage` (minus the `JSON.stringify`
/// — Tauri's IPC already hands this over as a parsed object). A full replace,
/// not a merge: a channel the user un-keyed disappears from here too.
///
/// Returns warnings for any entry that was not 32 bytes of hex, so the
/// frontend can surface them the same way `seedChannelKeysFromEnv`'s
/// warnings are logged; malformed entries are dropped rather than failing
/// the whole sync.
#[tauri::command]
pub fn sync_channel_keys(keys: HashMap<String, String>) -> Vec<String> {
    crate::channel_keys::sync_keys(keys)
}
