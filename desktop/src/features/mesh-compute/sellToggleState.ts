import type { MeshNodeStatus } from "@/shared/api/tauriMesh";

/**
 * Derived Sell-compute toggle model.
 *
 * Mirrors `shareToggleState.ts` for the other admission deal on the same
 * single mesh runtime slot: a self_only serve node (Sell compute) instead of
 * a community one (Share compute). Both report `mode: "serve"`, so the Sell
 * toggle must key off `admission`, not `mode` alone — otherwise a running
 * Share compute node would incorrectly light the Sell switch too (buzz#172).
 */
export type MeshSellToggleModel = {
  /**
   * The Sell switch is on: a self_only serve-mode node occupies the slot.
   * Stays true while starting or even failed (still turn-off-able to
   * clear/retry), same as Share compute's `isSharing`.
   */
  isSelling: boolean;
  /**
   * The single slot is occupied by something other than a Sell compute node
   * (Share compute or a consuming client). The Sell switch reads off while
   * true, and starting Sell would replace whatever is there.
   */
  blockedByOther: boolean;
  /** ANY runtime occupies the single slot (serve or client, healthy or failed). */
  slotOccupied: boolean;
};

/**
 * A runtime object occupies the slot once it is starting or running — and
 * also when it has `failed` (started, then errored; still in the slot).
 * `off`/`stopping` do not occupy it. Duplicated from `shareToggleState.ts`
 * rather than shared: it's five lines, and the two toggles are meant to stay
 * independently readable.
 */
function occupiesSlot(status: MeshNodeStatus | null): boolean {
  return (
    status?.state === "running" ||
    status?.state === "starting" ||
    status?.state === "failed"
  );
}

/**
 * Project a mesh node status into the Sell toggle's on/blocked state.
 *
 * Pure and total (accepts `null` = status not yet fetched).
 */
export function deriveMeshSellToggle(
  status: MeshNodeStatus | null,
): MeshSellToggleModel {
  const occupied = occupiesSlot(status);
  const isSelling =
    occupied && status?.mode === "serve" && status?.admission === "self_only";
  return {
    isSelling,
    blockedByOther: occupied && !isSelling,
    slotOccupied: occupied,
  };
}
