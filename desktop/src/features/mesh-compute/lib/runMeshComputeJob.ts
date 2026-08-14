import {
  callMeshComputeIngress,
  type MeshComputeIngressInput,
  type MeshComputeIngressResult,
} from "@/features/mesh-compute/lib/meshComputeIngressClient";
import type { MeshComputeJobRequest } from "@/features/mesh-compute/lib/meshComputeJobRequest";
import type { MeshComputeRefusalReason } from "@/features/mesh-compute/lib/meshComputeJobValidation";

/**
 * The post-accept half of the seller's job loop (issue steps 3–4): run an
 * already-`matchMeshComputeCapability`-accepted request against the local
 * ingress. This is where mesh-llm's `AUTO_MODEL_ID` ("auto") would apply too
 * — the request's own `model` tag is forwarded verbatim, so a buyer that
 * names `"auto"` gets the SDK's own context-compatible routing for free,
 * with no special-casing needed here.
 *
 * Deliberately stops at `{kind: "completed", text}` rather than publishing
 * anything: the caller (`useMeshComputeJobServer`) encrypts the text and
 * publishes the §6.2 `"completed-offer"`; arming the key release against the
 * buyer's paying PREPARE (§7 steps 3–7) is buzz#93's payment-leg scope.
 */

export type MeshComputeJobExecutionOutcome =
  | { kind: "refused"; reason: MeshComputeRefusalReason }
  | { kind: "completed"; text: string };

type CallIngress = (
  input: MeshComputeIngressInput,
) => Promise<MeshComputeIngressResult>;

export async function runMeshComputeJob(
  input: {
    request: MeshComputeJobRequest;
    /** From `matchMeshComputeCapability` — already ≤ the advertised ceiling. */
    maxTokens: number;
    advertisedMaxTokens: number;
    ingressBaseUrl: string;
  },
  callIngress: CallIngress = callMeshComputeIngress,
): Promise<MeshComputeJobExecutionOutcome> {
  const result = await callIngress({
    baseUrl: input.ingressBaseUrl,
    model: input.request.model,
    prompt: input.request.prompt,
    maxTokens: input.maxTokens,
    advertisedMaxTokens: input.advertisedMaxTokens,
  });

  if (!result.ok) return { kind: "refused", reason: result.reason };
  return { kind: "completed", text: result.text };
}
