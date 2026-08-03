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

const OUTCOMES: readonly FactoryJobOutcome[] = [
  "completed",
  "abandoned-provider",
  "abandoned-buyer",
];

function firstTag(tags: string[][], name: string): string[] | undefined {
  return tags.find((tag) => tag[0] === name);
}

function eTag(tags: string[][], marker: "root"): string | undefined {
  return tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1];
}

/** Parse a kind:6097 event. `null` for the wrong kind or a missing required tag. */
export function parseFactoryJobResult(event: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
}): FactoryJobResult | null {
  if (event.kind !== KIND_FACTORY_JOB_RESULT) return null;

  const rootJobId = eTag(event.tags, "root");
  const outcomeRaw = firstTag(event.tags, "outcome")?.[1];
  const incrementTag = firstTag(event.tags, "increment");
  if (!rootJobId || !outcomeRaw || !incrementTag) return null;
  if (!OUTCOMES.includes(outcomeRaw as FactoryJobOutcome)) return null;

  const reached = Number.parseInt(incrementTag[1] ?? "", 10);
  const of = Number.parseInt(incrementTag[2] ?? "", 10);
  if (!Number.isFinite(reached) || !Number.isFinite(of)) return null;

  const outcome = outcomeRaw as FactoryJobOutcome;
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
