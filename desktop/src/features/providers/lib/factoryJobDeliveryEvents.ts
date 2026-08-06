import type {
  FactoryJobRequest as RigFactoryJobRequest,
  FactoryMilestone,
  UnsignedEvent,
} from "@toon-protocol/rig";

import type { FactoryJobRequest } from "@/features/factory-jobs/lib/factoryJobRequest";

/**
 * Adapters between buzz's own factory-job shapes and `@toon-protocol/rig`'s
 * event builders (buzz#135). The builders are the proven, spec-compliant
 * source of the kind:7000 `partial`/`processing` and kind:6097 wire shapes
 * (rig#59's witnessed devnet proof ran on them) — buzz deliberately does not
 * re-derive a single tag locally. What buzz owns is only the mapping: its
 * parsed `FactoryJobRequest` (`factoryJobRequest.ts`) into rig's, and rig's
 * `UnsignedEvent` into the `signRelayEvent` template shape the Tauri signer
 * takes (`created_at` → `createdAt`).
 *
 * The compatibility contract runs the other way too: everything these
 * builders emit MUST parse unchanged through the buyer-side readers
 * (`factoryJobFeedback.ts`, `factoryJobResult.ts`) — asserted by this
 * module's unit tests, not assumed.
 */

/** Buzz's parsed kind:5097 request, reshaped for rig's builders. */
export function toRigFactoryJobRequest(
  job: FactoryJobRequest,
): RigFactoryJobRequest {
  return {
    requestEventId: job.eventId,
    buyerPubkey: job.buyerPubkey,
    brief: job.brief,
    bidMicroUsdc: job.bidBaseUnits.toString(),
    ...(job.repo !== null ? { repo: job.repo } : {}),
    ...(job.target !== null ? { target: job.target } : {}),
    ...(job.constraints !== null ? { constraints: job.constraints } : {}),
    ...(job.outputMimeType !== null ? { outputMime: job.outputMimeType } : {}),
  };
}

/**
 * Buzz quotes carry free-text milestone names (`QuoteForm` accepts anything);
 * rig's `IncrementSpec` types them as its three factory phases. The milestone
 * never reaches the increment-offer wire (§4.1 has no milestone tag — the
 * schedule already named it on the quote), so an unrecognized name is mapped
 * to the phase every custom milestone is a variant of rather than rejected.
 */
export function toRigMilestone(milestone: string): FactoryMilestone {
  return milestone === "plan" ||
    milestone === "implement" ||
    milestone === "review"
    ? milestone
    : "implement";
}

/** A rig `UnsignedEvent`, reshaped for `signRelayEvent`'s template input. */
export function asSignableTemplate(unsigned: UnsignedEvent): {
  kind: number;
  content: string;
  createdAt: number;
  tags: string[][];
} {
  return {
    kind: unsigned.kind,
    content: unsigned.content,
    createdAt: unsigned.created_at,
    tags: unsigned.tags,
  };
}
