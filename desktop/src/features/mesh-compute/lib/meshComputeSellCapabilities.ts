/**
 * Sell-compute capabilities the seller advertises (buzz#173, part of
 * toon-protocol/toon-meta#265's mesh-compute epic). Split out of buzz#90
 * alongside the admission lock (buzz#171) and the consent toggle (buzz#172):
 * this ticket owns *what* the seller advertises — the model it runs, the
 * VRAM ceiling it claims, and the local ingress a job handler talks to.
 *
 * `docs/mesh-compute-job-protocol.md` §3.1's `kind:31990` schema has no raw
 * `vram` tag — the VRAM ceiling here is the operator's own declared capacity
 * (mirroring the `maxVramGb` already passed to `mesh_start_node` for Share
 * Compute), which a later capability-computation ticket turns into the
 * spec's `context`/`max_tokens` tags. Recording it is a claim, not an
 * enforcement mechanism — see `meshComputeSellCapabilitiesStore.ts`'s module
 * doc for why this module does not reject work at the ceiling.
 *
 * NOTE: neither buzz#172 (the sell-mode toggle) nor buzz#91 (the kind:31990
 * publisher) exist in this codebase yet, so nothing here starts a node or
 * publishes an event — see `meshComputeSellCapabilitiesStore.ts` for the
 * readable-by-a-future-publisher half, the same shape buzz#165 used for
 * posted price.
 */

/**
 * The local OpenAI-compatible ingress a sell-mode job handler talks to when
 * no node is running yet. Mirrors `desktop/src-tauri/src/mesh_llm/mod.rs`'s
 * `MESH_LOOPBACK_HOST` ("127.0.0.1", pinned regardless of admission mode)
 * and `DEFAULT_MESH_API_PORT` (9337). In-process only — nothing here binds a
 * network-facing interface, and nothing should ever hand this URL to a
 * browser, a webhook, or any peer.
 */
export const MESH_COMPUTE_SELL_INGRESS_BASE_URL = "http://127.0.0.1:9337/v1";

/**
 * The ingress URL a job handler should call right now: the live serve-mode
 * status's own `apiBaseUrl` when a node is actually up and serving (it may
 * differ from the default if `BUZZ_MESH_API_PORT` was overridden), otherwise
 * the known default. Never returns a non-loopback URL, even if a caller
 * passes a status object claiming one — surfacing to the handler must not
 * become surfacing to the network (buzz#173 gotcha).
 *
 * A client-mode status's `apiBaseUrl` is deliberately ignored: that URL is
 * where this machine reaches a peer's compute, not where a job handler would
 * reach this machine's own serving.
 */
export function resolveMeshComputeSellIngressUrl(
  status: {
    mode: "serve" | "client" | null;
    state: string;
    apiBaseUrl: string | null;
  } | null,
): string {
  if (
    status?.mode === "serve" &&
    status.state === "running" &&
    status.apiBaseUrl?.startsWith("http://127.0.0.1:")
  ) {
    return status.apiBaseUrl;
  }
  return MESH_COMPUTE_SELL_INGRESS_BASE_URL;
}

/**
 * Parse the advertised VRAM ceiling field: a positive number (decimals
 * allowed — GPUs commonly report fractional GB), nothing else.
 */
export function parseMaxVramGbInput(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}
