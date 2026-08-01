import {
  decryptChannelMedia,
  type SealedMediaEnvelope,
} from "@/shared/api/channelMediaCrypto";
import { arweaveMediaCandidates } from "@/shared/lib/arweaveMedia";

/**
 * Turning permaweb ciphertext back into something an `<img>` can show.
 *
 * The render side of buzz#17. A sealed attachment's URL points at bytes no
 * browser can display — that is the whole point — so the renderer cannot be
 * handed the Arweave URL. It has to be handed a `blob:` URL over the decrypted
 * bytes, which means a fetch, a decrypt, and an object URL, none of which a
 * synchronous render can do.
 *
 * Hence a store: components ask for a URL, get whatever state it is in right
 * now, and re-render when that changes. Module-level rather than per-component
 * because the same attachment appears in the timeline, the lightbox, the
 * gallery and the thread panel at once, and each of those mounting its own
 * fetch-and-decrypt would pay for the same bytes several times over.
 *
 * ## Cache and lifetime
 *
 * Entries are keyed by blob URL and never evicted while the app runs. Object
 * URLs are only revoked by {@link resetSealedMediaStore}, which exists for
 * tests. That is a deliberate leak with a bound: media is content-addressed and
 * immutable, a timeline holds a bounded number of distinct attachments, and the
 * alternative — revoking on unmount — breaks the lightbox, which mounts a
 * second `<img>` over the same URL. If a long session's memory becomes a
 * problem the fix is an LRU here, not lifetime tracking at every call site.
 *
 * ## Locked is not an error
 *
 * A decrypt that returns null means this client holds no key that opens the
 * blob: a non-member, or a removed member looking at post-rotation media. That
 * is the ordinary case on an open relay and gets its own state, so the UI can
 * show #12's locked treatment rather than a broken image.
 */

/** Where one sealed attachment has got to. */
export type SealedMediaState =
  /** Fetch or decrypt in flight. */
  | { status: "loading" }
  /** Decrypted; `objectUrl` is safe to hand to an `<img>`/`<video>`. */
  | { status: "ready"; objectUrl: string }
  /** No held key opens it — non-member, or removed before this epoch. */
  | { status: "locked" }
  /** Every gateway refused, or the bytes were not what the envelope described. */
  | { status: "error" };

type Entry = { state: SealedMediaState; envelopeSha: string };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

/**
 * Bumped on every state change.
 *
 * The `useSyncExternalStore` snapshot: the states themselves live in a mutable
 * map, so there is no stable object to compare, and a counter is the smallest
 * thing that is both immutable and correct.
 */
let version = 0;

/** See {@link version}. */
export function getSealedMediaVersion(): number {
  return version;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function set(url: string, envelopeSha: string, state: SealedMediaState): void {
  entries.set(url, { state, envelopeSha });
  notify();
}

/** Observe state changes, for `useSyncExternalStore`. */
export function subscribeSealedMedia(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch the ciphertext for `url`, trying every gateway mirror in turn.
 *
 * Exported for tests, which need to drive the fallover without a network.
 * Returns null once every candidate has refused — the same shape a failed
 * decrypt produces, because to the caller they are the same outcome.
 */
export async function fetchSealedMediaBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array | null> {
  for (const candidate of arweaveMediaCandidates(url)) {
    try {
      const response = await fetchImpl(candidate);
      if (!response.ok) continue;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      // A gateway that refuses says nothing about whether the file exists:
      // Arweave content is mirrored, so the answer is to ask the next one.
    }
  }
  return null;
}

/**
 * Fetch and open one sealed attachment. Null when it cannot be opened at all.
 *
 * The seam the store is built on, and the one worth testing directly: it takes
 * its `fetch` as an argument and touches no DOM, so a member round-trip, a
 * non-member refusal and an every-gateway-down failure are all reachable from
 * a unit test.
 */
export async function openSealedMedia(
  url: string,
  envelope: SealedMediaEnvelope,
  channelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array | null> {
  const ciphertext = await fetchSealedMediaBytes(url, fetchImpl);
  if (ciphertext === null) return null;
  return decryptChannelMedia(ciphertext, envelope, channelId);
}

/**
 * The state of `url`, starting the work if it has not been started.
 *
 * Synchronous by design: a render asks and gets an answer on the spot, then
 * gets re-rendered by the subscription when the answer improves. The first call
 * returns `loading` and kicks off the fetch.
 *
 * Re-keyed on the envelope's ciphertext hash so an edit that re-points a URL at
 * different bytes — or a second envelope for a URL already cached — refetches
 * rather than showing the previous file.
 */
export function requestSealedMedia(
  url: string,
  envelope: SealedMediaEnvelope,
  channelId: string,
): SealedMediaState {
  const existing = entries.get(url);
  if (existing && existing.envelopeSha === envelope.sha256) {
    return existing.state;
  }

  entries.set(url, {
    state: { status: "loading" },
    envelopeSha: envelope.sha256,
  });

  void (async () => {
    let plaintext: Uint8Array | null = null;
    let fetched = false;
    try {
      const ciphertext = await fetchSealedMediaBytes(url);
      fetched = ciphertext !== null;
      if (ciphertext !== null) {
        plaintext = await decryptChannelMedia(ciphertext, envelope, channelId);
      }
    } catch (error) {
      console.warn("[sealed-media] could not resolve an attachment", error);
    }

    if (plaintext === null) {
      // Bytes we could not fetch is an availability failure; bytes we fetched
      // and could not open is a key we do not hold. The user can act on the
      // second (ask for the key) and not on the first, so they must not read
      // the same.
      set(url, envelope.sha256, { status: fetched ? "locked" : "error" });
      return;
    }

    const blob = new Blob([plaintext as unknown as BlobPart], {
      type: envelope.mime,
    });
    set(url, envelope.sha256, {
      status: "ready",
      objectUrl: URL.createObjectURL(blob),
    });
  })();

  return { status: "loading" };
}

/** Drop every cached entry and revoke its object URL. Test isolation only. */
export function resetSealedMediaStore(): void {
  for (const entry of entries.values()) {
    if (entry.state.status === "ready") {
      URL.revokeObjectURL(entry.state.objectUrl);
    }
  }
  entries.clear();
  listeners.clear();
}
