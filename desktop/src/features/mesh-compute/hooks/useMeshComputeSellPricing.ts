import * as React from "react";

import {
  getMeshComputeSellPricingSnapshot,
  type MeshComputeSellPricing,
  setMeshComputeSellPricing,
  subscribeToMeshComputeSellPricing,
} from "../lib/meshComputeSellPricingStore";

/**
 * The seller's posted price + output-token ceiling (buzz#165), reactively.
 * `revise` is the AC2 hook point: every call persists and bumps the store's
 * version, which is what a future kind:31990 publisher (buzz#91) would
 * subscribe to in order to re-publish without a node restart.
 */
export function useMeshComputeSellPricing(): {
  pricing: MeshComputeSellPricing;
  revise: (next: MeshComputeSellPricing) => void;
} {
  const pricing = React.useSyncExternalStore(
    subscribeToMeshComputeSellPricing,
    getMeshComputeSellPricingSnapshot,
  );
  return { pricing, revise: setMeshComputeSellPricing };
}
