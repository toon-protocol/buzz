import type { MeshComputeJobRequest } from "@/features/mesh-compute/lib/meshComputeJobRequest";
import type { MeshComputeSellCapabilities } from "@/features/mesh-compute/lib/meshComputeSellCapabilitiesStore";
import type { MeshComputeSellPricing } from "@/features/mesh-compute/lib/meshComputeSellPricingStore";

/**
 * The issue's step 2 ("Validate against what the 31990 advertises... model,
 * context limit, max tokens. Anything that does not fit is kind:7000
 * feedback, not a silent drop") against what buzz#91's kind:31990 publisher
 * will one day advertise — read here straight from the local
 * capabilities/pricing stores, the source of truth those tags are built
 * from, since buzz#91 does not exist in this codebase yet.
 *
 * `meshComputeSellCapabilitiesStore.ts`'s own doc names this module as the
 * owner of `max_tokens` enforcement ("the same way buzz#165 left max_tokens
 * enforcement to buzz#92"). `docs/mesh-compute-job-protocol.md` §9.2 only
 * names three refusal reasons; a request whose `max_tokens` exceeds the
 * advertised ceiling is reported as `"context-exceeded"` — the taxonomy has
 * no separate "ceiling exceeded" reason, and both are "this job asks for
 * more capacity than advertised."
 */

export type MeshComputeRefusalReason =
  | "vram-exhausted"
  | "model-not-loaded"
  | "context-exceeded";

export type MeshComputeCapabilityMatch =
  | { accepted: true; maxTokens: number }
  | { accepted: false; reason: MeshComputeRefusalReason };

/**
 * Model check first, ceiling second — an unmatched model makes the ceiling
 * question moot (there is no advertised ceiling for a model this seller
 * does not serve).
 */
export function matchMeshComputeCapability(
  request: MeshComputeJobRequest,
  capabilities: MeshComputeSellCapabilities,
  pricing: MeshComputeSellPricing,
): MeshComputeCapabilityMatch {
  if (!capabilities.modelId || request.model !== capabilities.modelId) {
    return { accepted: false, reason: "model-not-loaded" };
  }
  if (request.maxTokens > pricing.maxOutputTokens) {
    return { accepted: false, reason: "context-exceeded" };
  }
  return { accepted: true, maxTokens: request.maxTokens };
}
