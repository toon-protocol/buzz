import {
  isSealedMediaEnvelope,
  type SealedMediaEnvelope,
} from "@/shared/api/channelMediaCrypto";

/**
 * How a sealed-media envelope travels: inside the message content, never in a
 * tag (buzz#17).
 *
 * The obvious place to put "which key, which salt, which mime" is the NIP-92
 * `imeta` tag that already describes the attachment. It is also the wrong
 * place. Tags are not sealed — `channelMessageCrypto.ts` seals `content` and
 * leaves tags in the clear precisely so a client can route an event before it
 * can read it — so anything in a tag is broadcast to every reader of an open
 * relay. `mime`, `size`, `dim` and `filename` describe the *plaintext*, and
 * together they are most of what an attachment discloses even when the bytes
 * are unreadable.
 *
 * So the envelope rides in the content, which for a keyed channel is already
 * NIP-44 ciphertext by the time it leaves the process. The `imeta` tag keeps
 * only facts about the ciphertext that are public anyway: its Arweave URL, its
 * SHA-256 (which is what a tombstone names), its byte length, and
 * `application/octet-stream`.
 *
 * ## Wire layout
 *
 * One HTML comment on its own line at the end of the body:
 *
 * ```
 * <!--buzz:media/v1 {"https://arweave.net/<txid>":{ …envelope… }}-->
 * ```
 *
 * A comment rather than a fenced block or a custom sentinel because a client
 * that does not know about this — an older Buzz, another Nostr client with the
 * channel key — renders nothing for it. Markdown treats it as an HTML node and
 * every renderer either drops it or hides it; there is no reading in which it
 * appears as stray text next to the message. Buzz strips it explicitly anyway
 * (see {@link extractMediaEnvelopes}), because "some renderer probably hides
 * it" is not a thing to rely on for content the user wrote.
 *
 * Keyed by URL rather than positional, so a partial edit that drops one
 * attachment cannot silently re-point another one's envelope at the wrong blob.
 */

/** Marker opening the envelope comment. Versioned with the envelope shape. */
const MARKER = "buzz:media/v1";

/**
 * The envelope comment, anywhere in the content.
 *
 * Global and multiline so a body that somehow accumulated two of them (a
 * cross-client edit round-trip) has both stripped rather than one left behind
 * as visible junk.
 */
const ENVELOPE_RE = /^[ \t]*<!--buzz:media\/v1 (.*?)-->[ \t]*$/gm;

/** Envelopes by the URL of the blob each one opens. */
export type MediaEnvelopesByUrl = ReadonlyMap<string, SealedMediaEnvelope>;

/**
 * Append the envelope record for `envelopes` to `body`.
 *
 * A no-op for an empty record, so the send path can call it unconditionally:
 * a public channel's message must come out byte-identical to what it would
 * have been before this feature existed.
 */
export function appendMediaEnvelopes(
  body: string,
  envelopes: MediaEnvelopesByUrl,
): string {
  if (envelopes.size === 0) return body;
  const record: Record<string, SealedMediaEnvelope> = {};
  for (const [url, envelope] of envelopes) record[url] = envelope;
  // `--` inside the JSON would close the comment early. No envelope field can
  // contain one (hex, a MIME type, a number, a filename we escape below), but
  // encoding it rather than trusting that keeps the framing total.
  const json = JSON.stringify(record).replaceAll("--", "\\u002d\\u002d");
  const separator = body.endsWith("\n") || body === "" ? "" : "\n";
  return `${body}${separator}<!--${MARKER} ${json}-->`;
}

/**
 * Split `content` into the body to render and the envelopes it carried.
 *
 * Total: malformed JSON, an unknown envelope shape, and no marker at all
 * collapse to "no envelopes", with the marker still stripped from the body. A
 * reader that cannot understand the record must not show it, and must not fail
 * to show the message it was attached to.
 */
export function extractMediaEnvelopes(content: string): {
  body: string;
  envelopes: MediaEnvelopesByUrl;
} {
  const envelopes = new Map<string, SealedMediaEnvelope>();
  if (!content.includes(MARKER)) return { body: content, envelopes };

  const body = content
    .replace(ENVELOPE_RE, (_match, json: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json.replaceAll("\\u002d\\u002d", "--"));
      } catch {
        return "";
      }
      if (typeof parsed !== "object" || parsed === null) return "";
      for (const [url, envelope] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (isSealedMediaEnvelope(envelope)) envelopes.set(url, envelope);
      }
      return "";
    })
    // Stripping a whole line leaves its newline behind; the marker is always
    // last, so trimming the trailing blank is enough to keep the body exactly
    // what the author typed.
    .replace(/\n+$/, "");

  return { body, envelopes };
}

/** Whether `content` carries an envelope record at all. */
export function hasMediaEnvelopes(content: string): boolean {
  return content.includes(MARKER);
}
