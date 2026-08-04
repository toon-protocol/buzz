import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { verifyEvent } from "nostr-tools/pure";

import {
  type FactoryJobRequest,
  parseFactoryJobRequest,
} from "@/features/factory-jobs/lib/factoryJobRequest";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_FACTORY_JOB_REQUEST,
  KIND_GIFT_WRAP,
  KIND_SEAL,
} from "@/shared/constants/kinds";

/**
 * Inbound job feed (buzz#84 "What" §2), the gift-wrap half: a targeted brief
 * may be NIP-59 gift-wrapped (decision 1, toon-meta#262) so the relay sees
 * neither its content nor its sender — "a provider must be able to read one
 * it is addressed on, and must not assume plaintext" (the issue's own
 * gotcha). `postFactoryJob.ts::wrapFactoryJobRequest` is the send side of
 * this; there was no read side for a provider yet.
 *
 * This is NOT `nostr-tools/nip59`'s `unwrapEvent` — that helper decrypts both
 * layers and discards the seal, so the caller never learns who actually
 * signed the rumor, nor whether the seal's signature even verifies. Mirrors
 * `channelKeyDelivery.ts::unwrapChannelKey`'s reasoning exactly, generalized
 * to a different rumor kind: the seal's signer is the one fact a NIP-59
 * unwrap must not throw away, because it is the only authenticated claim of
 * who sent this. Duplicated in full here rather than shared with
 * `channelKeyDelivery.ts` — that module is buzz#16/#18's channel-membership
 * trust path, a different (and more sensitive) blast radius than a public
 * job market brief; the ~10 lines of crypto plumbing are cheap to keep
 * separate against that.
 */

type SealedLayer = {
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: unknown;
};

function openLayer(
  payload: string,
  secretKey: Uint8Array,
  counterparty: string,
): unknown {
  return JSON.parse(
    nip44Decrypt(payload, getConversationKey(secretKey, counterparty)),
  );
}

function asLayer(value: unknown): SealedLayer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== "number" ||
    typeof record.pubkey !== "string" ||
    typeof record.content !== "string" ||
    typeof record.created_at !== "number" ||
    !Array.isArray(record.tags)
  ) {
    return null;
  }
  return record as unknown as SealedLayer;
}

/** A brief that arrived gift-wrapped, plus who actually sent it. */
export type FactoryJobRequestGrant = {
  request: FactoryJobRequest;
  /** The seal's signer — the authenticated sender, never the wrap's ephemeral key. */
  sender: string;
  /** The wrap it came out of, for de-duplication. */
  wrapId: string;
};

/**
 * Open a gift wrap addressed to us and read the job brief out of it. Returns
 * `null` for anything that is not a well-formed brief for this recipient —
 * on the open job market that is the overwhelmingly common outcome (every
 * wrap addressed to someone else fails the MAC), not an error condition.
 */
export function unwrapFactoryJobRequestGift(
  wrap: RelayEvent,
  recipientSecretKey: Uint8Array,
): FactoryJobRequestGrant | null {
  if (wrap.kind !== KIND_GIFT_WRAP) return null;

  try {
    const seal = asLayer(
      openLayer(wrap.content, recipientSecretKey, wrap.pubkey),
    );
    if (!seal || seal.kind !== KIND_SEAL) return null;
    if (!verifyEvent(seal as unknown as Parameters<typeof verifyEvent>[0])) {
      return null;
    }

    const rumor = asLayer(
      openLayer(seal.content, recipientSecretKey, seal.pubkey),
    );
    if (!rumor || rumor.kind !== KIND_FACTORY_JOB_REQUEST) return null;
    // NIP-59: the seal's signer is the author, so a rumor claiming a
    // different one is a relayed forgery attempt.
    if (rumor.pubkey !== seal.pubkey) return null;

    const request = parseFactoryJobRequest({
      id: wrap.id,
      pubkey: rumor.pubkey,
      created_at: rumor.created_at,
      kind: rumor.kind,
      tags: rumor.tags as string[][],
    });
    if (!request) return null;

    return { request, sender: seal.pubkey, wrapId: wrap.id };
  } catch {
    // A wrap for another recipient fails the MAC here. That is the common path.
    return null;
  }
}
