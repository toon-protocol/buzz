import { isArweaveMediaUrl } from "@/shared/lib/arweaveMedia";
import { parseImetaTags } from "@/shared/ui/markdown/parseImeta";

/**
 * Tombstones: the only "delete" that exists for permaweb media.
 *
 * A file uploaded to the TOON store node is on Arweave. Nobody can remove it —
 * not the author, not the community operator, not the protocol (ADR 0002). A
 * tombstone therefore does not delete anything. It is a signed statement from
 * the author saying "stop showing this", which every client that trusts the
 * author's signature honours by not rendering the attachment. The bytes are
 * still there, still fetchable by anyone who kept the URL, forever.
 *
 * That distinction has to survive contact with the UI, which is why it is
 * spelled out here, in the copy this module owns, and in the permanence
 * disclosure the user accepted before their first upload. Any wording that
 * implies removal from storage is a bug, not a simplification.
 *
 * ## Event shape
 *
 * A media tombstone is a NIP-09 kind:5 with at least one `x` tag:
 *
 * ```
 * kind: 5
 * tags:
 *   ["h", "<channel uuid>"]        scope, matching every other channel event
 *   ["e", "<message event id>"]    the message whose attachment is withdrawn
 *   ["x", "<sha256 hex>"]          one per hidden attachment
 * content: ""
 * ```
 *
 * kind:5 rather than a new kind because "the author withdraws this" is exactly
 * NIP-09's meaning and clients that already drop deletion targets need no new
 * vocabulary. The `x` tag is what narrows it from the message to the media: a
 * kind:5 with no `x` is the existing whole-message deletion and keeps working
 * untouched, a kind:5 with `x` tags leaves the message standing and takes only
 * the named attachments out of the render. Splitting on a tag the old reducer
 * ignores is what makes the two coexist without a migration.
 *
 * On TOON, NIP-09's "request the relay delete this" reading does not apply
 * either: the relay serves everyone and enforces nothing (ADR 0001). Both
 * flavours are rendering hints. Only the media one is *irreversibly* so.
 */

/** NIP-09 deletion — the kind both whole-message and media tombstones use. */
export const KIND_MEDIA_TOMBSTONE = 5;

const SHA256_RE = /^[\da-f]{64}$/i;

/** The `x` values on `tags`, lowercased, ignoring anything that is not a sha256. */
export function mediaTombstoneHashes(
  tags: ReadonlyArray<ReadonlyArray<string>>,
): string[] {
  const hashes: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== "x") continue;
    const value = tag[1];
    if (typeof value === "string" && SHA256_RE.test(value)) {
      hashes.push(value.toLowerCase());
    }
  }
  return hashes;
}

/**
 * Whether a kind:5's tags mark it as a *media* tombstone rather than a
 * whole-message deletion.
 *
 * The caller is responsible for having checked the kind; this is only the tag
 * discriminator, so the timeline reducers can ask it without importing kind
 * constants in both directions.
 */
export function isMediaTombstone(
  tags: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return mediaTombstoneHashes(tags).length > 0;
}

/**
 * Tags for a tombstone hiding `sha256s` from the message `eventId`.
 *
 * Takes hashes, not URLs, because the hash is the attachment's identity: the
 * same bytes re-posted through a different gateway have a different URL and
 * the same `x`, and hiding should follow the content.
 */
export function buildMediaTombstoneTags({
  channelId,
  eventId,
  sha256s,
}: {
  channelId: string;
  eventId: string;
  sha256s: ReadonlyArray<string>;
}): string[][] {
  const unique = [
    ...new Set(
      sha256s
        .filter((hash) => SHA256_RE.test(hash))
        .map((hash) => hash.toLowerCase()),
    ),
  ];
  if (unique.length === 0) {
    throw new Error("a media tombstone must name at least one attachment");
  }
  return [
    ["h", channelId],
    ["e", eventId],
    ...unique.map((hash) => ["x", hash]),
  ];
}

/**
 * The sha256s of a message's attachments that live on the permaweb.
 *
 * Empty for a message whose media is on a relay's Blossom store, which is what
 * makes it usable as the "does this message need the honest copy?" test:
 * `Delete message` is true for a relay attachment and a lie for an Arweave one,
 * and only this can tell them apart.
 *
 * An attachment with no `x` tag is skipped: a tombstone identifies content by
 * hash, so one that cannot be named cannot be hidden.
 */
export function permanentMediaHashes(
  tags: ReadonlyArray<ReadonlyArray<string>> | undefined,
): string[] {
  if (!tags || tags.length === 0) return [];
  const hashes = new Set<string>();
  for (const entry of parseImetaTags(tags as string[][]).values()) {
    if (entry.x && isArweaveMediaUrl(entry.url)) {
      hashes.add(entry.x.toLowerCase());
    }
  }
  return [...hashes];
}

/** Which attachments each message has had withdrawn: event id → sha256 set. */
export function collectHiddenMedia(
  events: ReadonlyArray<{ kind: number; tags: string[][] }>,
): Map<string, Set<string>> {
  const hidden = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== KIND_MEDIA_TOMBSTONE) continue;
    const hashes = mediaTombstoneHashes(event.tags);
    if (hashes.length === 0) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "e" || typeof tag[1] !== "string") continue;
      const target = tag[1].toLowerCase();
      const set = hidden.get(target) ?? new Set<string>();
      for (const hash of hashes) set.add(hash);
      hidden.set(target, set);
    }
  }
  return hidden;
}

/** Matches a media or file attachment line the composer emitted for one URL. */
function attachmentLineUrl(line: string): string | null {
  const trimmed = line.trim();
  const media = /^(?:\|\|)?!\[(?:image|video)\]\(([^)\s]+)\)(?:\|\|)?$/.exec(
    trimmed,
  );
  if (media) return media[1];
  const file = /^\[(?:\\.|[^\]\\])*\]\(([^)\s]+)\)$/.exec(trimmed);
  return file ? file[1] : null;
}

/** A message with its withdrawn attachments taken out of the render. */
export type HiddenMediaResult = {
  content: string;
  tags: string[][];
  /** How many attachments were withdrawn, for the placeholder's wording. */
  hiddenCount: number;
};

/**
 * Drop every attachment named by `hiddenHashes` from a message's body and tags.
 *
 * Both halves have to go: the imeta tag is what the gallery and lightbox
 * enumerate, and the `![image](url)` line is what the markdown renderer draws.
 * Leaving either behind shows the media through the other path.
 *
 * Unlike `stripImetaMediaLines`, this removes matching lines wherever they sit
 * rather than only at the tail. A hidden attachment in the middle of a body is
 * unusual but must still disappear — "mostly hidden" is not a state this
 * feature is allowed to have.
 *
 * Returns the input unchanged (same object identity for `tags`) when nothing
 * matches, so the timeline's common path allocates nothing.
 */
export function hideTombstonedMedia({
  content,
  tags,
  hiddenHashes,
}: {
  content: string;
  tags: string[][];
  hiddenHashes: ReadonlySet<string> | undefined;
}): HiddenMediaResult {
  if (!hiddenHashes || hiddenHashes.size === 0) {
    return { content, tags, hiddenCount: 0 };
  }

  const hiddenUrls = new Set<string>();
  for (const entry of parseImetaTags(tags).values()) {
    if (entry.x && hiddenHashes.has(entry.x.toLowerCase())) {
      hiddenUrls.add(entry.url);
      // Thumbnails and poster frames are separate URLs derived from the same
      // upload; hiding the attachment has to take them too.
      if (entry.thumb) hiddenUrls.add(entry.thumb);
      if (entry.image) hiddenUrls.add(entry.image);
    }
  }

  if (hiddenUrls.size === 0) return { content, tags, hiddenCount: 0 };

  const nextTags = tags.filter((tag) => {
    if (tag[0] !== "imeta") return true;
    const url = tag
      .slice(1)
      .find((part) => part.startsWith("url "))
      ?.slice(4);
    return url === undefined || !hiddenUrls.has(url);
  });

  const nextContent = content
    .split("\n")
    .filter((line) => {
      const url = attachmentLineUrl(line);
      return url === null || !hiddenUrls.has(url);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");

  return {
    content: nextContent,
    tags: nextTags,
    hiddenCount: hiddenUrls.size,
  };
}

/**
 * The line shown in place of a withdrawn attachment.
 *
 * Says "hidden", never "deleted", and says where the file still is. A user who
 * reads this and concludes the file is gone has been misled by us, so the
 * second sentence is not optional politeness — it is the whole point.
 */
export function hiddenMediaNotice(hiddenCount: number): string {
  const subject = hiddenCount === 1 ? "attachment" : "attachments";
  return `_${hiddenCount} ${subject} hidden by the author. The ${hiddenCount === 1 ? "file remains" : "files remain"} on the permaweb and cannot be removed._`;
}
