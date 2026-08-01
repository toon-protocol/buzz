import {
  type ChannelKeyInbox,
  startChannelKeyInbox,
} from "@/shared/api/channelKeyInbox";
import { seedChannelKeysFromEnv } from "@/shared/api/channelKeyStore";
import { getIdentitySecretKey } from "@/shared/api/identitySecretKey";
import { getIdentity } from "@/shared/api/tauriIdentity";
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

let inbox: ChannelKeyInbox | null = null;

/**
 * Start watching for gift-wrapped channel keys (buzz#16).
 *
 * After the transport is installed and after the environment seed, so the
 * subscriptions go to the network this run actually uses and a key the
 * operator already supplied is not re-applied from a wrap.
 *
 * Never throws, and returns whether it started. Three ordinary situations
 * leave it stopped — no Tauri host (a browser dev server), no identity yet
 * (first-run onboarding, before the wizard has made a key), and a locked OS
 * keyring — and none of them is a reason for the app not to open. The cost is
 * that channels stay locked until the next launch, which is the same cost
 * #12's manual path already had.
 */
export async function installChannelKeyInbox(): Promise<boolean> {
  if (inbox) return true;

  try {
    const [identity, secretKey] = await Promise.all([
      getIdentity(),
      getIdentitySecretKey(),
    ]);
    inbox = await startChannelKeyInbox({
      pubkey: identity.pubkey,
      secretKey,
    });
    return true;
  } catch (error) {
    console.warn(
      "[channel-keys] not watching for gift-wrapped keys this session",
      error,
    );
    return false;
  }
}

/** Stop the inbox. For sign-out and for tests. */
export async function stopChannelKeyInbox(): Promise<void> {
  const running = inbox;
  inbox = null;
  await running?.stop();
}
