import type { SealedMediaEnvelope } from "@/shared/api/channelMediaCrypto";
import type { MediaEnvelopesByUrl } from "@/shared/api/mediaEnvelopeContent";
import type { SealedMediaState } from "@/shared/api/sealedMediaStore";
import {
  parseImetaTags,
  type ParsedImetaEntry,
} from "@/shared/ui/markdown/parseImeta";

/**
 * Projecting a message's sealed attachments into something the markdown
 * renderer can draw (buzz#17).
 *
 * The renderer knows nothing about encryption and should not learn: it takes a
 * body and an imeta lookup, and draws whatever URLs the body names. So the
 * substitution happens *before* it — the Arweave URL in the body is swapped for
 * the `blob:` URL over the decrypted bytes, and the imeta entry is re-keyed to
 * match and refilled with the plaintext's own mime, size and dimensions from the
 * envelope.
 *
 * Doing it here rather than inside `markdown.tsx` keeps one renderer for public
 * and private media. Video detection, the lightbox, the gallery, spoilers and
 * file cards all key on the imeta MIME and the URL in the body, and all of them
 * keep working unchanged because by the time they run, a sealed attachment
 * looks exactly like an unsealed one.
 *
 * An attachment that has not been opened is not swapped — there is nothing to
 * swap to — so its line is replaced with a text placeholder, the same treatment
 * #12 gives a message whose content will not open.
 */

/** Shown in place of an attachment this client holds no key for. */
export const LOCKED_ATTACHMENT_PLACEHOLDER =
  "[Encrypted attachment — this client does not have the channel key.]";

/** Shown while the ciphertext is being fetched and opened. */
export const DECRYPTING_ATTACHMENT_PLACEHOLDER = "[Decrypting attachment…]";

/** Shown when no gateway would serve the ciphertext. */
export const UNAVAILABLE_ATTACHMENT_PLACEHOLDER =
  "[Encrypted attachment — could not be fetched from any gateway.]";

function placeholderFor(state: SealedMediaState): string {
  switch (state.status) {
    case "loading":
      return DECRYPTING_ATTACHMENT_PLACEHOLDER;
    case "locked":
      return LOCKED_ATTACHMENT_PLACEHOLDER;
    default:
      return UNAVAILABLE_ATTACHMENT_PLACEHOLDER;
  }
}

/** The imeta entry a decrypted blob should render under. */
function openedEntry(
  objectUrl: string,
  envelope: SealedMediaEnvelope,
  original: ParsedImetaEntry | undefined,
): ParsedImetaEntry {
  return {
    ...original,
    url: objectUrl,
    // The envelope wins over the tag on every plaintext fact: the tag
    // describes the ciphertext (opaque type, sealed length) precisely so it
    // discloses nothing, and it is the envelope that knows what the file is.
    m: envelope.mime,
    size: envelope.size,
    // `x` stays the ciphertext hash. It is the attachment's public identity —
    // what `imeta x` published and what a `["x", …]` tombstone names — so the
    // hide path has to keep matching on it after decryption.
    x: envelope.sha256,
    ...(envelope.dim ? { dim: envelope.dim } : {}),
    ...(envelope.filename ? { filename: envelope.filename } : {}),
  };
}

/**
 * Rewrite `body` and `imetaByUrl` so decrypted attachments render and
 * undecryptable ones read as locked.
 *
 * Pure, and returns the *same* references when there is nothing sealed to do —
 * which is every public channel — so the memo in `MessageRow` does not
 * invalidate a timeline that did not change.
 *
 * A line is matched by the `](url)` that markdown link and image syntax share,
 * so `![image](url)`, a spoilered `||![image](url)||` and a `[filename](url)`
 * file card are all handled by one rule rather than three regexes that could
 * disagree.
 */
export function applySealedMessageMedia(
  body: string,
  imetaByUrl: ReadonlyMap<string, ParsedImetaEntry> | undefined,
  envelopes: ReadonlyMap<string, SealedMediaEnvelope> | undefined,
  resolutions: ReadonlyMap<string, SealedMediaState>,
): {
  body: string;
  imetaByUrl: ReadonlyMap<string, ParsedImetaEntry> | undefined;
} {
  if (!envelopes || envelopes.size === 0) return { body, imetaByUrl };

  const nextImeta = new Map(imetaByUrl ?? []);
  let nextBody = body;

  for (const [url, envelope] of envelopes) {
    const state = resolutions.get(url) ?? { status: "loading" as const };
    const original = nextImeta.get(url);
    // The sealed URL never renders: either it is replaced by the object URL or
    // the line it sits on is replaced by a placeholder.
    nextImeta.delete(url);

    if (state.status === "ready") {
      nextBody = nextBody.split(url).join(state.objectUrl);
      nextImeta.set(
        state.objectUrl,
        openedEntry(state.objectUrl, envelope, original),
      );
      continue;
    }

    const placeholder = placeholderFor(state);
    const needle = `](${url})`;
    nextBody = nextBody
      .split("\n")
      .map((line) => (line.includes(needle) ? placeholder : line))
      .join("\n");
  }

  return {
    body: nextBody,
    imetaByUrl: nextImeta.size > 0 ? nextImeta : undefined,
  };
}

/**
 * The envelopes whose attachment is still on the event.
 *
 * A tombstone takes an attachment out of the imeta tags and out of the body,
 * and its envelope has to go with it. Left behind, it would still name the
 * hidden blob's real filename, MIME and dimensions — the author asked clients
 * to stop showing that file, and half-honouring the request is worse than not
 * having a tombstone at all. It would also keep `sealedMediaStore` fetching and
 * decrypting bytes nothing renders.
 */
export function survivingMediaEnvelopes(
  envelopes: MediaEnvelopesByUrl,
  tags: string[][],
): MediaEnvelopesByUrl {
  if (envelopes.size === 0) return envelopes;
  const live = new Set(
    [...parseImetaTags(tags).values()].map((entry) => entry.url),
  );
  const kept = new Map<string, SealedMediaEnvelope>();
  for (const [url, envelope] of envelopes) {
    if (live.has(url)) kept.set(url, envelope);
  }
  return kept;
}
