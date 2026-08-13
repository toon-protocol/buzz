import {
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_REQUEST,
  KIND_FACTORY_JOB_RESULT,
} from "@/shared/constants/kinds";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import { parseFactoryJobFeedback } from "./factoryJobFeedback";
import { parseFactoryJobRequest } from "./factoryJobRequest";
import { parseFactoryJobResult } from "./factoryJobResult";

/**
 * Derives the compact channel-timeline card for a NIP-90 factory job event
 * (buzz#125). Always returns a labeled card — a malformed or empty-content
 * event (the parsers below return `null`/`"malformed"` rather than throwing)
 * still renders as an "unrecognized" card, never as an empty row.
 */
export type FactoryJobCardVariant =
  | "request"
  | "result-completed"
  | "result-abandoned"
  | "quote"
  | "partial"
  | "processing"
  | "unrecognized";

export type FactoryJobCardContent = {
  variant: FactoryJobCardVariant;
  title: string;
  description: string;
};

export type FactoryJobCardEvent = {
  id: string;
  pubkey: string;
  createdAt: number;
  kind: number;
  content: string;
  tags: string[][];
};

function truncate(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Maps the card's camelCase event shape to the snake_case shape the factory-job parsers expect. */
function toParserEvent(event: FactoryJobCardEvent) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.createdAt,
    kind: event.kind,
    content: event.content,
    tags: event.tags,
  };
}

function outcomeLabel(
  outcome: "completed" | "abandoned-provider" | "abandoned-buyer",
) {
  switch (outcome) {
    case "completed":
      return "Completed";
    case "abandoned-provider":
      return "Abandoned by provider";
    case "abandoned-buyer":
      return "Abandoned by buyer";
  }
}

function deriveRequestCard(event: FactoryJobCardEvent): FactoryJobCardContent {
  const parsed = parseFactoryJobRequest(toParserEvent(event));
  if (!parsed) {
    return {
      variant: "unrecognized",
      title: "Job request",
      description: "This job request is missing its brief.",
    };
  }
  return {
    variant: "request",
    title: "Job request",
    description: `${truncate(parsed.brief, 140)} · up to ${formatUsdcBaseUnits(parsed.bidBaseUnits)}`,
  };
}

function deriveResultCard(event: FactoryJobCardEvent): FactoryJobCardContent {
  const parsed = parseFactoryJobResult(toParserEvent(event));
  if (!parsed || "status" in parsed) {
    return {
      variant: "unrecognized",
      title: "Job result",
      description: parsed
        ? `This job result could not be read: ${parsed.reason}.`
        : "This job result is missing its outcome.",
    };
  }
  return {
    variant:
      parsed.outcome === "completed" ? "result-completed" : "result-abandoned",
    title: "Job result",
    description: `${outcomeLabel(parsed.outcome)} · increment ${parsed.increment.reached} of ${parsed.increment.of}`,
  };
}

function deriveFeedbackCard(event: FactoryJobCardEvent): FactoryJobCardContent {
  const parsed = parseFactoryJobFeedback(toParserEvent(event));
  if (!parsed || parsed.status === "malformed") {
    return {
      variant: "unrecognized",
      title: "Job update",
      description: "This job update could not be read.",
    };
  }
  if (parsed.status === "quote") {
    const total = parsed.increments.reduce(
      (sum, increment) => sum + increment.priceUsdcBaseUnits,
      0n,
    );
    return {
      variant: "quote",
      title: "Job quote",
      description: `${parsed.increments.length} increment${parsed.increments.length === 1 ? "" : "s"} · ${formatUsdcBaseUnits(total)} total`,
    };
  }
  if (parsed.status === "partial") {
    return {
      variant: "partial",
      title: "Job increment",
      description: `Increment ${parsed.increment.n} of ${parsed.increment.of} · ${formatUsdcBaseUnits(parsed.amountBaseUnits)}`,
    };
  }
  const narration = parsed.narration.trim();
  return {
    variant: "processing",
    title: "Job update",
    description:
      narration.length > 0 ? truncate(narration, 140) : "In progress…",
  };
}

export function deriveFactoryJobCard(
  event: FactoryJobCardEvent,
): FactoryJobCardContent {
  if (event.kind === KIND_FACTORY_JOB_REQUEST) return deriveRequestCard(event);
  if (event.kind === KIND_FACTORY_JOB_RESULT) return deriveResultCard(event);
  if (event.kind === KIND_FACTORY_JOB_FEEDBACK)
    return deriveFeedbackCard(event);
  return {
    variant: "unrecognized",
    title: "Job update",
    description: "Unrecognized job event.",
  };
}
