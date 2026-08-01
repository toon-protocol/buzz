import type { MediaUploadQuote } from "@/shared/api/mediaUpload";

/**
 * The permanence disclosure: telling a user that an attachment cannot be taken
 * back, before they post one that cannot be taken back.
 *
 * Media on the TOON store node is written to Arweave — world-readable and
 * permanent (ADR 0002). That is a bigger commitment than any other action in
 * the app makes, and it is invisible: the composer looks exactly like the one
 * that uploads to a relay an operator can clean up. So the first upload of a
 * session-independent lifetime is gated on an explicit acknowledgement that
 * names the fee, names the permanence, and — this is the part that is easy to
 * get wrong — is honest that the later "hide" action is a rendering request,
 * not a deletion.
 *
 * Once only, not every time: a per-upload confirmation trains people to click
 * through it, which is worse than not asking. The acknowledgement persists.
 *
 * `localStorage` in the app, an in-memory map anywhere else — the same shape
 * `toonOnboardingStore` uses. Losing it (cleared storage, new machine) just
 * means the user reads the disclosure once more, which is the safe failure.
 */

const STORAGE_KEY = "buzz-media-permanence-ack.v1";

export type PermanenceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): PermanenceStorage {
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

const fallbackStorage = memoryStorage();

function defaultStorage(): PermanenceStorage {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Storage access can throw outright under strict privacy settings.
  }
  return fallbackStorage;
}

/** Whether this user has already been shown, and accepted, the disclosure. */
export function hasAcknowledgedPermanence(
  storage: PermanenceStorage = defaultStorage(),
): boolean {
  try {
    return storage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Record the acknowledgement so later uploads go straight through. */
export function acknowledgePermanence(
  storage: PermanenceStorage = defaultStorage(),
): void {
  try {
    storage.setItem(STORAGE_KEY, "true");
  } catch {
    // A user who cannot persist the acknowledgement sees the disclosure again.
    // Annoying; never unsafe.
  }
}

/** Forget the acknowledgement, so the disclosure is shown again. */
export function forgetPermanenceAcknowledgement(
  storage: PermanenceStorage = defaultStorage(),
): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — the next read fails closed to "not acknowledged".
  }
}

/**
 * Whether `quote` must be disclosed before the bytes move.
 *
 * Only permanent backends, and only until acknowledged. A relay/Blossom upload
 * never discloses, because there is nothing irrevocable to disclose: pretending
 * otherwise would make the warning meaningless by the time it mattered.
 */
export function needsPermanenceDisclosure(
  quote: MediaUploadQuote,
  storage: PermanenceStorage = defaultStorage(),
): boolean {
  return quote.permanent && !hasAcknowledgedPermanence(storage);
}

/** Render a fee as the line shown in the disclosure. */
export function formatUploadFee(quote: MediaUploadQuote): string {
  if (quote.amount <= 0n) return "no fee on the current route";
  const divisor = 10 ** quote.assetScale;
  const value = Number(quote.amount) / divisor;
  const text = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: quote.assetScale,
  });
  return `${text} ${quote.asset}`;
}

/** Every string the disclosure dialog renders, assembled from a quote. */
export type PermanenceDisclosureCopy = {
  title: string;
  body: string[];
  feeLine: string;
  confirmLabel: string;
  cancelLabel: string;
};

/**
 * The disclosure copy for `quote`.
 *
 * Kept as data rather than JSX so the wording is unit-testable — specifically
 * so a test can assert that nothing here promises a deletion the store node
 * cannot perform.
 *
 * One disclosure for public and encrypted channels alike (buzz#17). The gate is
 * a property of the *backend* — the store node has no delete either way — and a
 * private-channel upload commits the user to exactly as much permanence as a
 * public one: the ciphertext is on the permaweb forever, and anyone who ever
 * obtains the channel key can read it retroactively. Softening the wording for
 * an encrypted channel would be describing a takedown that does not exist.
 */
export function permanenceDisclosureCopy(
  quote: MediaUploadQuote,
): PermanenceDisclosureCopy {
  return {
    title: "Attachments here are public and permanent",
    body: [
      "Files you attach are written to Arweave through the TOON store node. Anyone who has the link can read them.",
      "They cannot be removed — not by you, not by this community's operator, not by anyone. There is no takedown.",
      "In an encrypted channel the file is encrypted with the channel key before it is uploaded, so only members can read it. The encrypted file is still public and still permanent, and anyone who ever obtains the channel key can read it — including files you posted long before.",
      "Hiding an attachment later removes it from view in Buzz for everyone reading through this app. The file itself stays on the permaweb and stays reachable to anyone who kept the link.",
    ],
    feeLine:
      quote.amount <= 0n
        ? "Each upload is a paid write, but this route currently charges no fee."
        : `Each upload is a paid write costing ${formatUploadFee(quote)} from your payment channel.`,
    confirmLabel: "I understand — upload permanently",
    cancelLabel: "Cancel",
  };
}
