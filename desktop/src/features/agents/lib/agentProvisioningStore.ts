import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

/**
 * Whether buzz#74's provisioning flow has already confirmed it opened a
 * given agent's payment channel — one persisted flag per agent pubkey.
 *
 * Same tradeoff `toonOnboardingStore.ts` documents for its own single
 * channel-confirmed flag (see `agentProvisioningState.ts`'s header): there is
 * no free on-chain probe for "does this agent's derived address already have
 * a channel with this destination", so the flag is the source of truth for
 * the channel step, and it is safe to lose — a lost flag only re-runs the
 * channel-open step, which `ToonClient.openChannel` treats as idempotent per
 * peer.
 *
 * Keyed per pubkey (unlike the owner's single flag) because a host can run
 * many managed agents, each provisioning its own channel independently.
 */

const STORAGE_PREFIX = "buzz-agent-provisioning.v1";

export type AgentProvisioningStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): AgentProvisioningStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function defaultStorage(): AgentProvisioningStorage {
  if (typeof window === "undefined" || !window.localStorage) {
    return memoryStorage();
  }
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => {
      setLocalStorageItemWithRecovery(key, value);
    },
    removeItem: (key) => {
      window.localStorage.removeItem(key);
    },
  };
}

let storage: AgentProvisioningStorage = defaultStorage();
const listeners = new Set<() => void>();

/** Swap the backing store. For tests and for a future keychain backend. */
export function setAgentProvisioningStorage(
  next: AgentProvisioningStorage | null,
): void {
  storage = next ?? defaultStorage();
  notify();
}

function storageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}:${pubkey}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Whether this flow has already confirmed `pubkey`'s channel is open. */
export function isAgentChannelConfirmed(pubkey: string): boolean {
  try {
    return storage.getItem(storageKey(pubkey)) === "true";
  } catch (error) {
    console.warn(
      "[agent-provisioning] could not read the channel-confirmed flag",
      error,
    );
    return false;
  }
}

export function setAgentChannelConfirmed(
  pubkey: string,
  confirmed: boolean,
): void {
  try {
    if (confirmed) {
      storage.setItem(storageKey(pubkey), "true");
    } else {
      storage.removeItem(storageKey(pubkey));
    }
  } catch (error) {
    console.warn(
      "[agent-provisioning] could not persist the channel-confirmed flag",
      error,
    );
  }
  notify();
}

/** Observe any change — the provisioning UI re-renders from this. */
export function subscribeToAgentProvisioningState(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
