import { useMeshComputeJobServer } from "@/features/mesh-compute/hooks/useMeshComputeJobServer";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  getActiveToonTransport,
  getActiveTransportSelection,
} from "@/shared/api/transportSelection";

/**
 * Always-mounted host for the seller's mesh-compute job loop (buzz#92) —
 * the loop must run while the app is up, not only while a particular panel
 * is open, or the seller silently stops serving the moment the operator
 * navigates away. Renders nothing; every gate (mesh node actually serving,
 * transport able to release a key) lives inside `useMeshComputeJobServer`
 * itself, so an idle desktop opens no subscription and spends no paid
 * writes. What it does pay, always, is `useMeshNodeStatus`'s
 * `mesh_node_status` poll — the signal the serving gate reads — which
 * answers from a stopped runtime without touching the mesh.
 *
 * The transport is resolved synchronously, the
 * `factoryJobAvailability.ts` way: the transport this run installed does
 * not change mid-session (it is decided once, at bootstrap — see
 * `transportSelection.ts`).
 */
export function MeshComputeJobServerHost(): null {
  const identityQuery = useIdentityQuery();
  const isToon = getActiveTransportSelection()?.mode === "toon";
  const transport = isToon ? getActiveToonTransport() : null;
  useMeshComputeJobServer(transport, identityQuery.data?.pubkey ?? null);
  return null;
}
