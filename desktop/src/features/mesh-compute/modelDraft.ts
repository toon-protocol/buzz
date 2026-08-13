/**
 * Storage key for "this machine's model" — intentionally the same key
 * `MeshComputeSettingsCard.tsx` (Share compute) already reads/writes as
 * `MODEL_DRAFT_STORAGE_KEY`. Per epic decision 4 (toon-meta#265): one node,
 * one whole model at a time, whether it's being shared for free or sold.
 * Sell compute reads this value rather than growing its own model field, so
 * the two consent surfaces can't silently drift onto different models.
 */
export const MESH_MODEL_DRAFT_STORAGE_KEY = "buzz.mesh-compute.share.model.v1";

/** Read-only for Sell compute — Share compute owns writing this draft. */
export function readMeshModelDraft(): string {
  try {
    return window.localStorage.getItem(MESH_MODEL_DRAFT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
