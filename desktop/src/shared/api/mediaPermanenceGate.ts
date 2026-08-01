import {
  acknowledgePermanence,
  needsPermanenceDisclosure,
  permanenceDisclosureCopy,
  type PermanenceDisclosureCopy,
} from "@/shared/api/mediaPermanence";
import {
  MediaUploadDeclined,
  quoteMediaUpload,
} from "@/shared/api/mediaUpload";

/**
 * The permanence gate: turn "this user has not yet agreed to permanent
 * uploads" into a promise the upload path can await.
 *
 * A module-level store rather than a React hook, for two reasons. The
 * acknowledgement is a property of the *user*, not of a composer — there are
 * several composers alive at once (channel, thread panel, forum) and a
 * per-composer gate would render a stack of identical dialogs and ask again
 * after every channel switch. And the upload path that needs it
 * (`useMediaUpload`'s guarded helpers) is several layers below any component
 * that could reasonably own the dialog.
 *
 * So: one queue here, one `<MediaPermanenceDialog />` mounted at the app root,
 * and a plain async function for callers. Whether to ask at all lives in
 * `mediaPermanence.ts`; how the question looks lives in the dialog.
 */

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

let disclosure: PermanenceDisclosureCopy | null = null;
let waiters: Waiter[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to disclosure open/close, for `useSyncExternalStore`. */
export function subscribeMediaPermanence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open disclosure's copy, or null when nothing is being asked. */
export function getMediaPermanenceDisclosure(): PermanenceDisclosureCopy | null {
  return disclosure;
}

function settle(accepted: boolean): void {
  const pending = waiters;
  waiters = [];
  disclosure = null;
  emit();
  // One answer settles every upload that queued behind the dialog — a
  // multi-file drop asks once, not once per file.
  for (const { resolve, reject } of pending) {
    if (accepted) resolve();
    else reject(new MediaUploadDeclined());
  }
}

/** The user accepted: remember it and release every parked upload. */
export function acceptMediaPermanence(): void {
  acknowledgePermanence();
  settle(true);
}

/** The user declined: reject every parked upload. */
export function declineMediaPermanence(): void {
  settle(false);
}

/**
 * Resolve once an upload may proceed; reject with {@link MediaUploadDeclined}
 * if the user says no.
 *
 * Quotes the active media backend on every call rather than caching: the fee
 * is the connector's answer, not ours, and a stale number in a consent dialog
 * is worse than a round-trip. A backend that makes no permanence promise
 * (Blossom on the community relay) resolves immediately — the disclosure would
 * be describing a commitment that upload is not making.
 */
export async function requireMediaUploadConsent(): Promise<void> {
  const quote = await quoteMediaUpload();
  if (!needsPermanenceDisclosure(quote)) return;

  return new Promise<void>((resolve, reject) => {
    waiters.push({ resolve, reject });
    disclosure = permanenceDisclosureCopy(quote);
    emit();
  });
}

/** Drop all state. Test isolation only. */
export function resetMediaPermanenceGate(): void {
  waiters = [];
  disclosure = null;
  listeners.clear();
}
