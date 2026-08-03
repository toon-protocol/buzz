import { KIND_FACTORY_JOB_REQUEST } from "@/shared/constants/kinds";

/**
 * kind:5097 — the buyer's brief, per `docs/factory-job-protocol.md` §2 in
 * toon-meta. This module only builds and reads the tags; signing, gift
 * wrapping, and publishing are separate concerns (`postFactoryJob.ts`).
 */

/** What a buyer supplies to post a job. `bidBaseUnits` is a MAXIMUM, not an offer. */
export type FactoryJobRequestInput = {
  brief: string;
  bidBaseUnits: bigint;
  repo?: string;
  target?: string;
  constraints?: string;
  outputMimeType?: string;
  /** Present only for a targeted (and, per §2.2, gift-wrappable) brief. */
  targetProviderPubkey?: string;
};

export type FactoryJobRequestTemplate = {
  kind: typeof KIND_FACTORY_JOB_REQUEST;
  content: string;
  tags: string[][];
};

/** Build the unsigned kind:5097 template. Content is always empty — the brief lives on the `i` tag. */
export function buildFactoryJobRequest(
  input: FactoryJobRequestInput,
): FactoryJobRequestTemplate {
  if (!input.brief.trim()) {
    throw new Error("A job request needs a brief.");
  }
  if (input.bidBaseUnits <= 0n) {
    throw new Error("A job request's bid must be a positive amount.");
  }

  const tags: string[][] = [
    ["i", input.brief.trim(), "text"],
    ["bid", input.bidBaseUnits.toString(), "usdc"],
  ];
  if (input.repo) tags.push(["param", "repo", input.repo]);
  if (input.target) tags.push(["param", "target", input.target]);
  if (input.constraints) tags.push(["param", "constraints", input.constraints]);
  if (input.outputMimeType) tags.push(["output", input.outputMimeType]);
  if (input.targetProviderPubkey) {
    tags.push(["p", input.targetProviderPubkey]);
  }

  return { kind: KIND_FACTORY_JOB_REQUEST, content: "", tags };
}

/** A parsed kind:5097, read back for the buyer's own posted-job view. */
export type FactoryJobRequest = {
  eventId: string;
  buyerPubkey: string;
  createdAt: number;
  brief: string;
  bidBaseUnits: bigint;
  repo: string | null;
  target: string | null;
  constraints: string | null;
  outputMimeType: string | null;
  targetProviderPubkey: string | null;
};

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

function paramValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === "param" && tag[1] === name)?.[2];
}

/** Parse a kind:5097 event. Returns `null` when the required tags are missing or malformed — never throws on untrusted input. */
export function parseFactoryJobRequest(event: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
}): FactoryJobRequest | null {
  if (event.kind !== KIND_FACTORY_JOB_REQUEST) return null;

  const brief = tagValue(event.tags, "i");
  const bidRaw = tagValue(event.tags, "bid");
  if (!brief || !bidRaw) return null;

  let bidBaseUnits: bigint;
  try {
    bidBaseUnits = BigInt(bidRaw);
  } catch {
    return null;
  }
  if (bidBaseUnits <= 0n) return null;

  return {
    eventId: event.id,
    buyerPubkey: event.pubkey,
    createdAt: event.created_at,
    brief,
    bidBaseUnits,
    repo: paramValue(event.tags, "repo") ?? null,
    target: paramValue(event.tags, "target") ?? null,
    constraints: paramValue(event.tags, "constraints") ?? null,
    outputMimeType: tagValue(event.tags, "output") ?? null,
    targetProviderPubkey: tagValue(event.tags, "p") ?? null,
  };
}
