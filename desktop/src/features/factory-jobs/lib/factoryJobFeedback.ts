import { KIND_FACTORY_JOB_FEEDBACK } from "@/shared/constants/kinds";

/**
 * kind:7000 — the shared feedback kind, disambiguated by its `status` tag
 * into three shapes per `docs/factory-job-protocol.md` (toon-meta):
 *
 * - §3 `"quote"` — the RFQ reply, before any work happens.
 * - §4 `"partial"` — a paid increment offer. **This is the join between the
 *   relay plane and the connector plane** — `conditionHex` is what a paying
 *   ILP PREPARE's `executionCondition` must equal, byte for byte.
 * - §6 `"processing"` — free narration. MUST NOT carry `i`/`amount`/
 *   `condition` — an event with `status:"processing"` and any of them is
 *   malformed per spec, and this parser treats it as such rather than
 *   guessing which reading was intended.
 *
 * This module only reads; it never decides whether to pay (see
 * `factoryJobExposure.ts`) or builds a request (`factoryJobRequest.ts` is the
 * buyer's own event type — kind:7000 is always provider-authored).
 */

export type FactoryJobQuoteIncrement = {
  n: number;
  of: number;
  milestone: string;
  priceUsdcBaseUnits: bigint;
};

type FeedbackCommon = {
  eventId: string;
  providerPubkey: string;
  createdAt: number;
  /** The kind:5097 job request this feedback is about. */
  rootJobId: string;
};

export type FactoryJobQuote = FeedbackCommon & {
  status: "quote";
  increments: FactoryJobQuoteIncrement[];
};

export type FactoryJobIncrementOffer = FeedbackCommon & {
  status: "partial";
  /** The quote (increment 1) or previous increment's offer (increment ≥ 2). */
  parentEventId: string | null;
  increment: { n: number; of: number };
  artifactUrl: string;
  artifactHash: string | null;
  amountBaseUnits: bigint;
  /** `sha256(key)`, hex — the hashlock the paying PREPARE's `executionCondition` must match. */
  conditionHex: string;
};

export type FactoryJobNarration = FeedbackCommon & {
  status: "processing";
  parentEventId: string | null;
  narration: string;
};

export type FactoryJobFeedbackMalformed = {
  status: "malformed";
  eventId: string;
  reason: string;
};

export type FactoryJobFeedback =
  | FactoryJobQuote
  | FactoryJobIncrementOffer
  | FactoryJobNarration
  | FactoryJobFeedbackMalformed;

function malformed(
  eventId: string,
  reason: string,
): FactoryJobFeedbackMalformed {
  return { status: "malformed", eventId, reason };
}

function eTag(tags: string[][], marker: "root" | "reply"): string | undefined {
  return tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1];
}

function firstTag(tags: string[][], name: string): string[] | undefined {
  return tags.find((tag) => tag[0] === name);
}

function parseQuoteContent(content: string): FactoryJobQuoteIncrement[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { increments?: unknown }).increments)
  ) {
    return null;
  }

  const increments: FactoryJobQuoteIncrement[] = [];
  for (const raw of (parsed as { increments: unknown[] }).increments) {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.n !== "number" ||
      typeof entry.of !== "number" ||
      typeof entry.milestone !== "string" ||
      typeof entry.priceUsdc !== "string"
    ) {
      return null;
    }
    let priceUsdcBaseUnits: bigint;
    try {
      priceUsdcBaseUnits = BigInt(entry.priceUsdc);
    } catch {
      return null;
    }
    if (priceUsdcBaseUnits < 0n) return null;
    increments.push({
      n: entry.n,
      of: entry.of,
      milestone: entry.milestone,
      priceUsdcBaseUnits,
    });
  }
  return increments;
}

/**
 * Parse a kind:7000 event. Never throws on untrusted input — an
 * unrecognized or malformed event becomes `{status: "malformed"}` so a
 * caller can skip it (and, for narration in particular, MUST NOT attempt to
 * pay against it — see the module doc).
 */
export function parseFactoryJobFeedback(event: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}): FactoryJobFeedback | null {
  if (event.kind !== KIND_FACTORY_JOB_FEEDBACK) return null;

  const status = firstTag(event.tags, "status")?.[1];
  const rootJobId = eTag(event.tags, "root");
  if (!rootJobId) return malformed(event.id, "missing root e-tag");

  const common: FeedbackCommon = {
    eventId: event.id,
    providerPubkey: event.pubkey,
    createdAt: event.created_at,
    rootJobId,
  };

  if (status === "quote") {
    const increments = parseQuoteContent(event.content);
    if (!increments) return malformed(event.id, "unparseable quote content");
    return { ...common, status: "quote", increments };
  }

  const hasArtifactTags =
    firstTag(event.tags, "amount") !== undefined ||
    firstTag(event.tags, "condition") !== undefined ||
    event.tags.some((tag) => tag[0] === "i");

  if (status === "processing") {
    if (hasArtifactTags) {
      return malformed(
        event.id,
        "narration MUST NOT carry i/amount/condition tags",
      );
    }
    return {
      ...common,
      status: "processing",
      parentEventId: eTag(event.tags, "reply") ?? null,
      narration: event.content,
    };
  }

  if (status === "partial") {
    const incrementTag = firstTag(event.tags, "increment");
    const artifactTag = event.tags.find(
      (tag) => tag[0] === "i" && tag[2] === "url",
    );
    const hashTag = event.tags.find(
      (tag) => tag[0] === "i" && tag[4] === "hash",
    );
    const amountTag = firstTag(event.tags, "amount");
    const conditionTag = firstTag(event.tags, "condition");

    if (!incrementTag || !artifactTag || !amountTag || !conditionTag) {
      return malformed(event.id, "partial offer missing a required tag");
    }

    const n = Number.parseInt(incrementTag[1] ?? "", 10);
    const of = Number.parseInt(incrementTag[2] ?? "", 10);
    if (!Number.isFinite(n) || !Number.isFinite(of) || n < 1 || of < n) {
      return malformed(event.id, "malformed increment tag");
    }

    let amountBaseUnits: bigint;
    try {
      amountBaseUnits = BigInt(amountTag[1] ?? "");
    } catch {
      return malformed(event.id, "malformed amount tag");
    }

    const conditionHex = (conditionTag[1] ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(conditionHex)) {
      return malformed(event.id, "condition must be 32 bytes hex");
    }

    return {
      ...common,
      status: "partial",
      parentEventId: eTag(event.tags, "reply") ?? null,
      increment: { n, of },
      artifactUrl: artifactTag[1] ?? "",
      artifactHash: hashTag?.[1] ?? null,
      amountBaseUnits,
      conditionHex,
    };
  }

  return malformed(event.id, `unrecognized status tag: ${status ?? "(none)"}`);
}
