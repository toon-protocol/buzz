import type { MeshComputeRefusalReason } from "@/features/mesh-compute/lib/meshComputeJobValidation";
import { KIND_MESH_COMPUTE_JOB_FEEDBACK } from "@/shared/constants/kinds";

/**
 * The seller's half of kind:7000 for a mesh-compute job — §9.1 "accepted",
 * §9.2 "refused", and §6.2 "completed-offer" from
 * `docs/mesh-compute-job-protocol.md`. Accepted/refused are prompt, free
 * (no `amount`/`condition`) acknowledgments. The completed-offer carries the
 * completion itself — encrypted, inline in content per the ratified §8.1
 * split (toon-meta#317: the fact of the job is public, its substance is
 * not) — plus the `amount`/`condition` pair the buyer's paying PREPARE
 * matches byte for byte. Building and publishing the offer is this ticket's
 * completion path (buzz#92); answering the PREPARE with the key (§7 steps
 * 3–7) is buzz#93's payment leg.
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

/**
 * Build the unsigned kind:7000 `status:"completed-offer"` template (§6.2) —
 * the join between the relay plane and the connector plane. `content` is the
 * completion's ciphertext (base64); `condition` is `sha256(key)` from the
 * delivery port's `encryptArtifact`, the value the buyer's PREPARE's
 * `executionCondition` must equal byte for byte.
 */
export function buildMeshComputeCompletedOfferEvent(input: {
  rootJobId: string;
  /** The seller's own kind:7000 `accepted` event this offer replies to (§6.2). */
  acceptedEventId: string;
  buyerPubkey: string;
  /** The job's price in micro-USDC — derivable by the buyer from public information (§6.2). */
  amountMicroUsdc: bigint;
  /** `sha256(key)`, hex — from `encryptArtifact` (§6.1). */
  conditionHex: string;
  /** The completion itself, encrypted, inline (§6.2) — base64 ciphertext. */
  ciphertextBase64: string;
}): MeshComputeFeedbackTemplate {
  requireNonBlank(input.rootJobId, "job it is answering");
  requireNonBlank(input.acceptedEventId, "acceptance it replies to");
  requireNonBlank(input.buyerPubkey, "buyer it is answering");
  requireNonBlank(input.conditionHex, "hashlock condition");
  requireNonBlank(input.ciphertextBase64, "encrypted completion");
  if (input.amountMicroUsdc <= 0n) {
    throw new Error(
      "Mesh-compute completed-offer needs a positive amount — a free offer has nothing to hashlock against.",
    );
  }

  return {
    kind: KIND_MESH_COMPUTE_JOB_FEEDBACK,
    content: input.ciphertextBase64,
    tags: [
      ["status", "completed-offer"],
      ["e", input.rootJobId, "", "root"],
      ["e", input.acceptedEventId, "", "reply"],
      ["p", input.buyerPubkey],
      ["amount", input.amountMicroUsdc.toString(), "usdc"],
      ["condition", input.conditionHex],
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
