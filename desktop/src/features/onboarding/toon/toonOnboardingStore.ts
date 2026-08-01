import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

/**
 * Where the TOON onboarding wizard's own state lives between launches:
 * the generated/imported payment mnemonic, plus the two facts re-entrancy
 * cannot cheaply re-derive from a live read (see `toonOnboardingState.ts`) —
 * whether the channel-open step's consented action has already succeeded,
 * and whether the first-message step has.
 *
 * Modeled on `channelKeyStore.ts`: `localStorage` in the app, an in-memory
 * map anywhere else, and the same honest threat-model statement — this
 * protects the wallet from nothing but casual disclosure. It is the same
 * secret `BUZZ_TOON_MNEMONIC` already carries in plaintext in the process
 * environment; storing it lets the wizard generate an identity for a user who
 * launched the app with nothing; it does not make the identity more or less
 * sensitive than the env var did.
 */

const STORAGE_KEY = "buzz-toon-onboarding.v1";

type StoredState = {
  mnemonic: string | null;
  channelConfirmed: boolean;
  firstMessageSent: boolean;
};

const EMPTY_STATE: StoredState = {
  mnemonic: null,
  channelConfirmed: false,
  firstMessageSent: false,
};

export type ToonOnboardingStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): ToonOnboardingStorage {
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

function defaultStorage(): ToonOnboardingStorage {
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

let storage: ToonOnboardingStorage = defaultStorage();
let cache: StoredState | null = null;
const listeners = new Set<() => void>();

/** Swap the backing store. For tests and for a future keychain backend. */
export function setToonOnboardingStorage(
  next: ToonOnboardingStorage | null,
): void {
  storage = next ?? defaultStorage();
  cache = null;
}

function isStoredState(value: unknown): value is Partial<StoredState> {
  return typeof value === "object" && value !== null;
}

function readStore(): StoredState {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn("[toon-onboarding] could not read stored state", error);
    return { ...EMPTY_STATE };
  }
  if (!raw) return { ...EMPTY_STATE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("[toon-onboarding] stored state was not readable JSON", error);
    return { ...EMPTY_STATE };
  }
  if (!isStoredState(parsed)) return { ...EMPTY_STATE };

  return {
    mnemonic: typeof parsed.mnemonic === "string" ? parsed.mnemonic : null,
    channelConfirmed: parsed.channelConfirmed === true,
    firstMessageSent: parsed.firstMessageSent === true,
  };
}

function ensureCache(): StoredState {
  cache ??= readStore();
  return cache;
}

function persist(state: StoredState): void {
  try {
    if (
      state.mnemonic === null &&
      !state.channelConfirmed &&
      !state.firstMessageSent
    ) {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch (error) {
    console.warn("[toon-onboarding] could not persist state", error);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function update(patch: Partial<StoredState>): void {
  const next = { ...ensureCache(), ...patch };
  cache = next;
  persist(next);
  notify();
}

/** The stored payment mnemonic, or null before identity creation/import. */
export function getStoredMnemonic(): string | null {
  return ensureCache().mnemonic;
}

/** Store (or, with null, forget) the wizard's payment mnemonic. */
export function setStoredMnemonic(mnemonic: string | null): void {
  update({ mnemonic });
}

/** Whether the channel-open step's consented action has already succeeded. */
export function isToonChannelConfirmed(): boolean {
  return ensureCache().channelConfirmed;
}

export function setToonChannelConfirmed(confirmed: boolean): void {
  update({ channelConfirmed: confirmed });
}

/** Whether the wizard's first-message step has already succeeded. */
export function isToonFirstMessageSent(): boolean {
  return ensureCache().firstMessageSent;
}

export function setToonFirstMessageSent(sent: boolean): void {
  update({ firstMessageSent: sent });
}

/** Forget everything — for a "start over" / "use a different wallet" action. */
export function resetToonOnboardingState(): void {
  cache = { ...EMPTY_STATE };
  persist(cache);
  notify();
}

/** Observe any change — the wizard UI re-renders from this. */
export function subscribeToToonOnboardingState(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
