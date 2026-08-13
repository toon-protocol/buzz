import type { RelayEvent } from "@/shared/api/types";
import { KIND_MESH_COMPUTE_JOB_RESULT } from "@/shared/constants/kinds";

/**
 * kind:6098 — the terminal result, per §9.3 of
 * `docs/mesh-compute-job-protocol.md`. This module only ever builds the
 * `"refused"` outcome: `"completed"` requires the hashlocked completed-offer
 * to have been paid (§7, §9.3) — buzz#93's payment leg, not this ticket —
 * and `"abandoned-provider"`/`"abandoned-buyer"` are recorded by the
 * *absence* of a terminal event (§9.3, mirroring
 * `docs/factory-job-protocol.md`'s identical "recorded by simply not
 * delivering" rule), never published here either.
 */

export type MeshComputeJobResultTemplate = {
  kind: typeof KIND_MESH_COMPUTE_JOB_RESULT;
  content: string;
  tags: string[][];
};

function requireNonBlank(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`Mesh-compute job result needs a ${label}.`);
  }
}

/** Build the unsigned kind:6098 `outcome:"refused"` template (§9.3). */
export function buildMeshComputeJobResultEvent(input: {
  rootJobId: string;
  /** The last kind:7000 event before this terminal result (§9.3's reply e-tag). */
  lastEventId: string;
  buyerPubkey: string;
  /** The original kind:5098 event, verbatim — the result's `request` tag. */
  requestEvent: RelayEvent;
  outcome: "refused";
}): MeshComputeJobResultTemplate {
  requireNonBlank(input.rootJobId, "job it is closing out");
  requireNonBlank(input.lastEventId, "last feedback event it replies to");
  requireNonBlank(input.buyerPubkey, "buyer it is answering");

  return {
    kind: KIND_MESH_COMPUTE_JOB_RESULT,
    content: "",
    tags: [
      ["e", input.rootJobId, "", "root"],
      ["e", input.lastEventId, "", "reply"],
      ["p", input.buyerPubkey],
      ["request", JSON.stringify(input.requestEvent)],
      ["outcome", input.outcome],
    ],
  };
}
