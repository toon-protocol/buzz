import * as React from "react";

import { applySealedMessageMedia } from "@/features/messages/lib/sealedMessageMedia";
import type { TimelineMessage } from "@/features/messages/types";
import { readChannelTag } from "@/shared/api/channelMessageCrypto";
import {
  getSealedMediaVersion,
  requestSealedMedia,
  type SealedMediaState,
  subscribeSealedMedia,
} from "@/shared/api/sealedMediaStore";
import { parseImetaTags } from "@/shared/ui/markdown/parseImeta";
import type { ParsedImetaEntry } from "@/shared/ui/markdown/parseImeta";

/**
 * The body and imeta lookup to render one message with, sealed attachments
 * opened where this client can open them (buzz#17).
 *
 * Replaces the bare `parseImetaTags(message.tags)` a message row used to do.
 * For every public message that is exactly what it still does, by the same
 * memo, returning the same references — the sealed path costs nothing until a
 * message actually carries an envelope.
 *
 * The channel comes from the event's own `h` tag rather than a prop. It is
 * already there on every channel-scoped event, it is what
 * `channelMessageCrypto` uses to pick the key that opened the *content*, and
 * threading a second copy of it down through the row would create a way for
 * the two to disagree.
 */
export function useSealedMessageMedia(message: TimelineMessage): {
  body: string;
  imetaByUrl: ReadonlyMap<string, ParsedImetaEntry> | undefined;
} {
  const baseImeta = React.useMemo(
    () => (message.tags ? parseImetaTags(message.tags) : undefined),
    [message.tags],
  );

  // Re-render when any attachment finishes fetching or decrypting. The store
  // is shared, so a version counter is the snapshot; see `sealedMediaStore.ts`.
  const version = React.useSyncExternalStore(
    subscribeSealedMedia,
    getSealedMediaVersion,
    getSealedMediaVersion,
  );

  const envelopes = message.mediaEnvelopes;
  const channelId = React.useMemo(
    () => (message.tags ? readChannelTag(message.tags) : null),
    [message.tags],
  );

  // `version` is the store's invalidation signal: it is not read in the body,
  // it is what makes the store's asynchronous progress reach this memo at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  return React.useMemo(() => {
    if (!envelopes || envelopes.size === 0 || channelId === null) {
      return { body: message.body, imetaByUrl: baseImeta };
    }
    const resolutions = new Map<string, SealedMediaState>();
    for (const [url, envelope] of envelopes) {
      // Idempotent and cached: the first ask starts the fetch, every later one
      // reads the state it produced. Safe to call from a memo, and safe under
      // StrictMode's double invoke.
      resolutions.set(url, requestSealedMedia(url, envelope, channelId));
    }
    return applySealedMessageMedia(
      message.body,
      baseImeta,
      envelopes,
      resolutions,
    );
  }, [baseImeta, channelId, envelopes, message.body, version]);
}
