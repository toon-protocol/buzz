import * as React from "react";

import {
  getMeshComputeSellCapabilitiesSnapshot,
  type MeshComputeSellCapabilities,
  setMeshComputeSellCapabilities,
  subscribeToMeshComputeSellCapabilities,
} from "../lib/meshComputeSellCapabilitiesStore";

/**
 * The seller's advertised model + VRAM ceiling (buzz#173), reactively.
 * `revise` is the AC1/AC2 hook point: every call persists and bumps the
 * store's version, which is what a future kind:31990 publisher (buzz#91)
 * would subscribe to in order to re-publish without a node restart — same
 * mechanism as `useMeshComputeSellPricing.ts` (buzz#165).
 */
export function useMeshComputeSellCapabilities(): {
  capabilities: MeshComputeSellCapabilities;
  revise: (next: MeshComputeSellCapabilities) => void;
} {
  const capabilities = React.useSyncExternalStore(
    subscribeToMeshComputeSellCapabilities,
    getMeshComputeSellCapabilitiesSnapshot,
  );
  return { capabilities, revise: setMeshComputeSellCapabilities };
}
