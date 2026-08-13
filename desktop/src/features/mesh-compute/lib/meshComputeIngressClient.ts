import type { MeshComputeRefusalReason } from "@/features/mesh-compute/lib/meshComputeJobValidation";

/**
 * The seller's local client for `127.0.0.1:9337/v1` — the same
 * OpenAI-compatible ingress buzz's own agents already consume (issue step
 * 3), reached here via `fetch` since desktop's CSP is disabled
 * (`tauri.conf.json`) and the URL is always loopback
 * (`meshComputeSellCapabilities.ts`'s `resolveMeshComputeSellIngressUrl`).
 *
 * The bearer token matches `RELAY_MESH_API_KEY_PLACEHOLDER`
 * (`desktop/src-tauri/src/managed_agents/relay_mesh.rs`) — a fixed local
 * placeholder, not a secret; the ingress never leaves loopback.
 *
 * mesh-llm is a third-party pin this repo does not own, and there is no
 * documented error-response contract for its OpenAI-compatible surface, so
 * `classifyMeshComputeIngressFailure` is a best-effort keyword classifier
 * over the response body, not a guarantee. It is exported and separately
 * tested so refining it later (once real failure payloads are observed)
 * does not touch the request/response plumbing around it.
 */

const MESH_COMPUTE_INGRESS_API_KEY = "buzz-mesh-local";

export type MeshComputeIngressResult =
  | { ok: true; text: string }
  | { ok: false; reason: MeshComputeRefusalReason };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/**
 * Best-effort mapping from an ingress failure to one of the spec's three
 * refusal reasons (§9.2 — there is no fourth "unknown" reason). Falls back
 * to `"model-not-loaded"`: an unrecognized failure means this seller cannot
 * serve the job right now, which is the closest honest reading of the three
 * options when nothing more specific is known.
 */
export function classifyMeshComputeIngressFailure(
  status: number,
  bodyText: string,
): MeshComputeRefusalReason {
  const lower = bodyText.toLowerCase();
  if (/vram|out of memory|\boom\b|cuda.*memory/.test(lower)) {
    return "vram-exhausted";
  }
  if (
    /context.?length|context.?window|too (many|long)|maximum context|exceeds? the.*context/.test(
      lower,
    )
  ) {
    return "context-exceeded";
  }
  if (status === 404 || /model.*(not found|not loaded|unknown)/.test(lower)) {
    return "model-not-loaded";
  }
  return "model-not-loaded";
}

function extractCompletionText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown })?.message;
  const content = (message as { content?: unknown })?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Run one prompt against the local ingress. `maxTokens` is clamped to
 * `advertisedMaxTokens` before the request leaves this machine — defense in
 * depth per the issue's own gotcha ("do not trust the request"), even though
 * `matchMeshComputeCapability` should already have refused anything over the
 * ceiling before this is ever called.
 */
export async function callMeshComputeIngress(
  input: {
    baseUrl: string;
    model: string;
    prompt: string;
    maxTokens: number;
    advertisedMaxTokens: number;
  },
  fetchImpl: FetchLike = fetch,
): Promise<MeshComputeIngressResult> {
  const cappedMaxTokens = Math.min(input.maxTokens, input.advertisedMaxTokens);

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${MESH_COMPUTE_INGRESS_API_KEY}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }],
        max_tokens: cappedMaxTokens,
      }),
    });
  } catch {
    // Unreachable ingress — nothing is being served right now.
    return { ok: false, reason: "model-not-loaded" };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      ok: false,
      reason: classifyMeshComputeIngressFailure(response.status, bodyText),
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "model-not-loaded" };
  }

  const text = extractCompletionText(payload);
  if (text === null) return { ok: false, reason: "model-not-loaded" };
  return { ok: true, text };
}
