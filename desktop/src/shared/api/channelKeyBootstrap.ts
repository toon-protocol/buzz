import { seedChannelKeysFromEnv } from "@/shared/api/channelKeyStore";
import { getTransportEnv } from "@/shared/api/tauriTransport";

/**
 * Load `BUZZ_CHANNEL_KEYS` into the channel-key store before the app renders.
 *
 * Runs at bootstrap so no subscription can deliver a message the client had
 * the key for but had not loaded yet — a locked placeholder that later becomes
 * readable is a worse bug than one that never does, because nothing
 * re-decrypts a timeline already in cache.
 *
 * Never throws. A host without the Tauri bridge (a browser dev server,
 * a Playwright run) simply has no environment to read, and the keys a human
 * pasted into channel settings are already persisted.
 */
export async function loadChannelKeysFromEnvironment(): Promise<void> {
  let env: Record<string, string> = {};
  try {
    env = await getTransportEnv();
  } catch (error) {
    console.warn("[channel-keys] could not read the environment", error);
    return;
  }

  for (const warning of seedChannelKeysFromEnv(env)) {
    console.warn(`[channel-keys] ${warning}`);
  }
}
