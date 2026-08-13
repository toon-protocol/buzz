import { KIND_FACTORY_JOB_RESULT } from "@/shared/constants/kinds";

/**
 * kind:6097 — the terminal state, per §5 of `docs/factory-job-protocol.md`
 * (toon-meta). Decision 8 computes reputation from exactly these three
 * outcomes and nothing else — no reviews, no bonds.
 */
export type FactoryJobOutcome =
  | "completed"
  | "abandoned-provider"
  | "abandoned-buyer";

export type FactoryJobResult = {
  eventId: string;
  providerPubkey: string;
  createdAt: number;
  rootJobId: string;
  outcome: FactoryJobOutcome;
  increment: { reached: number; of: number };
  /** Only present when `outcome === "completed"`. */
  finalArtifactUrl: string | null;
};

export type FactoryJobResultMalformed = {
  status: "malformed";
  eventId: string;
  reason: string;
};

const OUTCOMES: readonly FactoryJobOutcome[] = [
  "completed",
  "abandoned-provider",
  "abandoned-buyer",
];

function firstTag(tags: string[][], name: string): string[] | undefined {
  return tags.find((tag) => tag[0] === name);
}

function eTag(tags: string[][], marker: "root" | "reply"): string | undefined {
  return tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1];
}

function malformed(eventId: string, reason: string): FactoryJobResultMalformed {
  return { status: "malformed", eventId, reason };
}

/** Narrows a `parseFactoryJobResult` hit to its malformed report. */
export function isFactoryJobResultMalformed(
  parsed: FactoryJobResult | FactoryJobResultMalformed,
): parsed is FactoryJobResultMalformed {
  return "status" in parsed;
}

/**
 * Parse a kind:6097 event. `null` for the wrong kind; a `{status:
 * "malformed"}` reporting which field failed for anything else — mirrors
 * `parseFactoryJobFeedback`'s malformed reporting for kind:7000.
 */
export function parseFactoryJobResult(event: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
}): FactoryJobResult | FactoryJobResultMalformed | null {
  if (event.kind !== KIND_FACTORY_JOB_RESULT) return null;

  const rootJobId = eTag(event.tags, "root");
  if (!rootJobId) return malformed(event.id, "missing root e-tag");

  // §5.1 Required, presence-checked only: no reader here needs the offer this
  // replies to or the buyer, but a 6097 without them is malformed — the same
  // bar `parseFactoryJobFeedback` holds a §4.1 partial offer to.
  if (!eTag(event.tags, "reply")) {
    return malformed(event.id, "missing reply e-tag");
  }
  if (!firstTag(event.tags, "p")?.[1]) {
    return malformed(event.id, "missing buyer p tag");
  }

  const outcomeRaw = firstTag(event.tags, "outcome")?.[1];
  if (!outcomeRaw) return malformed(event.id, "missing outcome tag");
  if (!OUTCOMES.includes(outcomeRaw as FactoryJobOutcome)) {
    return malformed(event.id, `unrecognized outcome tag: ${outcomeRaw}`);
  }

  const incrementTag = firstTag(event.tags, "increment");
  if (!incrementTag) return malformed(event.id, "missing increment tag");

  // Also presence-only: the embedded kind:5097 is there for auditors of the
  // thread, and no reader here looks inside it.
  if (!firstTag(event.tags, "request")?.[1]) {
    return malformed(event.id, "missing request tag");
  }

  const reached = Number.parseInt(incrementTag[1] ?? "", 10);
  const of = Number.parseInt(incrementTag[2] ?? "", 10);
  if (!Number.isFinite(reached) || !Number.isFinite(of)) {
    return malformed(event.id, "malformed increment tag");
  }

  const outcome = outcomeRaw as FactoryJobOutcome;
  if (outcome === "completed" && reached !== of) {
    return malformed(
      event.id,
      "completed outcome with reached increment !== of",
    );
  }
  const artifactTag = event.tags.find(
    (tag) => tag[0] === "i" && tag[2] === "url",
  );

  return {
    eventId: event.id,
    providerPubkey: event.pubkey,
    createdAt: event.created_at,
    rootJobId,
    outcome,
    increment: { reached, of },
    finalArtifactUrl:
      outcome === "completed" ? (artifactTag?.[1] ?? null) : null,
  };
}
