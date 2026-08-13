import type { MeshComputeRefusalReason } from "@/features/mesh-compute/lib/meshComputeJobValidation";
import { KIND_MESH_COMPUTE_JOB_FEEDBACK } from "@/shared/constants/kinds";

/**
 * The seller's half of kind:7000 for a mesh-compute job — §9.1 "accepted"
 * and §9.2 "refused" from `docs/mesh-compute-job-protocol.md`. Both are
 * prompt, free (no `amount`/`condition`) acknowledgments; the paid
 * `"completed-offer"` shape (§6.2, hashlocked) is the payment leg's own
 * scope (buzz#93), not built here.
 *
 * A refusal MUST be prompt (§9.2, and the issue's own gotcha: "a buyer
 * waiting on a timeout is worse for the seller's reputation than a fast
 * decline") — this module only builds the template; promptness is the
 * caller's job.
 */

export type MeshComputeFeedbackTemplate = {
  kind: typeof KIND_MESH_COMPUTE_JOB_FEEDBACK;
  content: string;
  tags: string[][];
};

function requireNonBlank(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`Mesh-compute feedback needs a ${label}.`);
  }
}

/** Build the unsigned kind:7000 `status:"accepted"` template (§9.1). */
export function buildMeshComputeAcceptedEvent(input: {
  rootJobId: string;
  buyerPubkey: string;
}): MeshComputeFeedbackTemplate {
  requireNonBlank(input.rootJobId, "job it is answering");
  requireNonBlank(input.buyerPubkey, "buyer it is answering");

  return {
    kind: KIND_MESH_COMPUTE_JOB_FEEDBACK,
    content: "",
    tags: [
      ["status", "accepted"],
      ["e", input.rootJobId, "", "root"],
      ["p", input.buyerPubkey],
    ],
  };
}

/** Build the unsigned kind:7000 `status:"refused"` template (§9.2). */
export function buildMeshComputeRefusedEvent(input: {
  rootJobId: string;
  buyerPubkey: string;
  reason: MeshComputeRefusalReason;
  /** Optional free-text elaboration — `reason` is the machine-readable field retry logic keys on. */
  message?: string;
}): MeshComputeFeedbackTemplate {
  requireNonBlank(input.rootJobId, "job it is answering");
  requireNonBlank(input.buyerPubkey, "buyer it is answering");

  return {
    kind: KIND_MESH_COMPUTE_JOB_FEEDBACK,
    content: input.message ?? "",
    tags: [
      ["status", "refused"],
      ["e", input.rootJobId, "", "root"],
      ["p", input.buyerPubkey],
      ["reason", input.reason],
    ],
  };
}
