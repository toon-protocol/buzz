import { KIND_MESH_COMPUTE_JOB_REQUEST } from "@/shared/constants/kinds";

/**
 * kind:5098 — the buyer's job request, per
 * `docs/mesh-compute-job-protocol.md` §5.1 in toon-meta. Read-only: the
 * buyer builds this event (a separate, buyer-side ticket); this module is
 * the seller's reader, mirroring `factoryJobRequest.ts`'s parse half.
 */

export type MeshComputeJobRequest = {
  eventId: string;
  buyerPubkey: string;
  createdAt: number;
  /** The `i` tag's value — plaintext, or NIP-44 ciphertext when `encrypted`. */
  prompt: string;
  /** Whether `prompt` is NIP-44 ciphertext rather than plain text (§8.1). */
  encrypted: boolean;
  /** The targeted seller (`p` tag) — always present, never a broadcast (§5.1, §2). */
  sellerPubkey: string;
  model: string;
  maxTokens: number;
  priceAccept: {
    microUsdc: bigint;
    unit: string;
  };
};

function firstTag(tags: string[][], name: string): string[] | undefined {
  return tags.find((tag) => tag[0] === name);
}

/**
 * Parse a kind:5098 event. Returns `null` when a Required tag is missing or
 * malformed — never throws on untrusted input, same convention as
 * `parseFactoryJobRequest`.
 */
export function parseMeshComputeJobRequest(event: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
}): MeshComputeJobRequest | null {
  if (event.kind !== KIND_MESH_COMPUTE_JOB_REQUEST) return null;

  const iTag = firstTag(event.tags, "i");
  const sellerPubkey = firstTag(event.tags, "p")?.[1];
  const model = firstTag(event.tags, "model")?.[1];
  const maxTokensRaw = firstTag(event.tags, "max_tokens")?.[1];
  const priceAcceptTag = firstTag(event.tags, "price_accept");

  if (
    !iTag?.[1] ||
    !sellerPubkey ||
    !model ||
    !maxTokensRaw ||
    !priceAcceptTag
  ) {
    return null;
  }

  const maxTokens = Number.parseInt(maxTokensRaw, 10);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null;

  if (priceAcceptTag[2] !== "usdc") return null;
  let microUsdc: bigint;
  try {
    microUsdc = BigInt(priceAcceptTag[1] ?? "");
  } catch {
    return null;
  }
  if (microUsdc <= 0n) return null;

  return {
    eventId: event.id,
    buyerPubkey: event.pubkey,
    createdAt: event.created_at,
    prompt: iTag[1],
    encrypted: event.tags.some((tag) => tag[0] === "encrypted"),
    sellerPubkey,
    model,
    maxTokens,
    priceAccept: {
      microUsdc,
      unit: priceAcceptTag[3] ?? "",
    },
  };
}
