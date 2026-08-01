import { invoke } from "@tauri-apps/api/core";
import {
  channelKeyRecord,
  subscribeToChannelKeys,
} from "@/shared/api/channelKeyStore";

/**
 * Push the TS channel-key store to Rust (buzz#33).
 *
 * Symmetric to `rustWriteBridge.ts`, in the other direction: that module
 * lets a Rust-built write ride the frontend's transport; this one lets a
 * Rust-built *event* — a threaded reply, a media message, a custom-emoji
 * message, a huddle STT transcript — seal its content the same way
 * `sendStreamMessage` does before signing (`channelMessageCrypto.ts`, buzz#12).
 * Rust has no `localStorage`, so `buzz-channel-keys.v1` has to reach it some
 * other way; this is that way.
 *
 * `sync_channel_keys` fully replaces Rust's copy on every call — never a
 * merge — so a key removed from channel settings is forgotten on the Rust
 * side too. It is called once at startup (an unkeyed app has nothing to
 * push, which is a normal no-op) and again on every
 * {@link subscribeToChannelKeys} notification, i.e. whenever a human pastes,
 * rotates, or removes a key, or `BUZZ_CHANNEL_KEYS` reseeds the store.
 *
 * `BUZZ_CHANNEL_KEYS` is also read directly by Rust
 * (`channel_keys::seed_from_env`) as a fallback layer for a write attempted
 * before this sync has run once — this module is the primary path, not the
 * only one.
 */
const SYNC_COMMAND = "sync_channel_keys";

async function pushToRust(): Promise<void> {
  try {
    const warnings = await invoke<string[]>(SYNC_COMMAND, {
      keys: channelKeyRecord(),
    });
    for (const warning of warnings) {
      console.warn(`[channel-keys] ${warning}`);
    }
  } catch (error) {
    // Same posture as `installRustWriteBridge`: a host with no Tauri bridge
    // (a browser dev server, a Playwright run) has nothing to sync to, and a
    // transient IPC failure here must not fail app startup — the next store
    // change retries, and Rust's own `BUZZ_CHANNEL_KEYS` fallback covers a
    // write attempted in the meantime.
    console.warn("[channel-keys] could not sync keys to the Rust side", error);
  }
}

/**
 * Install the sync: one immediate push for whatever the store already
 * holds, then one more on every subsequent change. Returns the unsubscribe
 * function, for symmetry with {@link subscribeToChannelKeys} — nothing
 * currently calls it, since the sync is meant to live for the app's whole
 * session, but a caller that tears down (a test harness) can stop it.
 */
export function installChannelKeySync(): () => void {
  void pushToRust();
  return subscribeToChannelKeys(() => {
    void pushToRust();
  });
}
