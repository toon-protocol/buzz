import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

/**
 * Advertise a capability (buzz#84 "What" §1): the owner marking an agent as a
 * provider for the factory job market. Per decision 14 (toon-meta#262),
 * provider eligibility is permissionless — the only gates are economic,
 * commercial and reputational — so this is a plain local toggle with no
 * approval step, not a request that goes anywhere.
 *
 * There is deliberately no NIP-89 (`kind:31990`)-style announcement event
 * here: `toon-meta#263` (the protocol spec this feature builds against)
 * specifies the request/quote/offer/result/narration wire and nothing else —
 * no discovery kind has been allocated. That is fine for this surface's
 * pull-based shape: a provider does not need to announce itself to be found,
 * because it finds jobs by reading the open `kind:5097` feed directly
 * (`useInboundFactoryJobs.ts`) and a buyer never needs to have heard of a
 * provider before it quotes. `repoFilter` and `description` are read
 * entirely client-side to decide which inbound jobs to surface and what to
 * show once a quote is offered — never published.
 *
 * Storage shape mirrors `agentProvisioningStore.ts`: one JSON blob per agent
 * pubkey, swappable backing store for tests.
 */

export type ProviderCapabilitySettings = {
  /** Whether this agent is currently willing to be shown inbound jobs. */
  enabled: boolean;
  /** Free-text shown to a buyer once a quote is offered — what this agent serves. */
  description: string;
  /**
   * Which `param:repo` values this agent will quote on. Empty means "any
   * repo" — the common case, and the honest default for a generalist agent.
   */
  repoFilter: string[];
};

export const DEFAULT_PROVIDER_CAPABILITY_SETTINGS: ProviderCapabilitySettings =
  {
    enabled: false,
    description: "",
    repoFilter: [],
  };

const STORAGE_PREFIX = "buzz-provider-capability.v1";

export type ProviderCapabilityStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): ProviderCapabilityStorage {
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

function defaultStorage(): ProviderCapabilityStorage {
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

let storage: ProviderCapabilityStorage = defaultStorage();
const listeners = new Set<() => void>();

/** Swap the backing store. For tests and for a future keychain backend. */
export function setProviderCapabilityStorage(
  next: ProviderCapabilityStorage | null,
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

function isValid(value: unknown): value is ProviderCapabilitySettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enabled === "boolean" &&
    typeof record.description === "string" &&
    Array.isArray(record.repoFilter) &&
    record.repoFilter.every((entry) => typeof entry === "string")
  );
}

/** This agent's provider capability settings, or the disabled default if never set. */
export function getProviderCapabilitySettings(
  pubkey: string,
): ProviderCapabilitySettings {
  try {
    const raw = storage.getItem(storageKey(pubkey));
    if (!raw) return DEFAULT_PROVIDER_CAPABILITY_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : DEFAULT_PROVIDER_CAPABILITY_SETTINGS;
  } catch (error) {
    console.warn(
      "[provider-capability] could not read settings, treating as disabled",
      error,
    );
    return DEFAULT_PROVIDER_CAPABILITY_SETTINGS;
  }
}

export function setProviderCapabilitySettings(
  pubkey: string,
  settings: ProviderCapabilitySettings,
): void {
  try {
    storage.setItem(storageKey(pubkey), JSON.stringify(settings));
  } catch (error) {
    console.warn("[provider-capability] could not persist settings", error);
  }
  notify();
}

/** Observe any change — the provider settings UI re-renders from this. */
export function subscribeToProviderCapabilitySettings(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
