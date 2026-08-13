import {
  buildMeshComputeAcceptedEvent,
  buildMeshComputeRefusedEvent,
} from "@/features/mesh-compute/lib/meshComputeJobFeedback";
import { buildMeshComputeJobResultEvent } from "@/features/mesh-compute/lib/meshComputeJobResult";
import type { MeshComputeRefusalReason } from "@/features/mesh-compute/lib/meshComputeJobValidation";
import { signRelayEvent } from "@/shared/api/tauri";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Sign + publish the seller's kind:7000/kind:6098 templates, mirroring
 * `postFactoryJobQuote.ts`'s sign-then-publish shape exactly: build the
 * unsigned template, sign it via the Rust `sign_event` IPC (the identity's
 * key never leaves Rust), publish over the transport.
 */

export async function publishMeshComputeAccepted(
  input: { rootJobId: string; buyerPubkey: string },
  transport: ToonEventTransport,
): Promise<RelayEvent> {
  const template = buildMeshComputeAcceptedEvent(input);
  const event = await signRelayEvent(template);
  return transport.publish(event, {
    timeoutMessage: "Timed out while accepting the job.",
    sendErrorMessage: "Failed to accept the job.",
  });
}

export async function publishMeshComputeRefused(
  input: {
    rootJobId: string;
    buyerPubkey: string;
    reason: MeshComputeRefusalReason;
    message?: string;
  },
  transport: ToonEventTransport,
): Promise<RelayEvent> {
  const template = buildMeshComputeRefusedEvent(input);
  const event = await signRelayEvent(template);
  return transport.publish(event, {
    timeoutMessage: "Timed out while declining the job.",
    sendErrorMessage: "Failed to decline the job.",
  });
}

export async function publishMeshComputeJobResult(
  input: {
    rootJobId: string;
    lastEventId: string;
    buyerPubkey: string;
    requestEvent: RelayEvent;
    outcome: "refused";
  },
  transport: ToonEventTransport,
): Promise<RelayEvent> {
  const template = buildMeshComputeJobResultEvent(input);
  const event = await signRelayEvent(template);
  return transport.publish(event, {
    timeoutMessage: "Timed out while publishing the job result.",
    sendErrorMessage: "Failed to publish the job result.",
  });
}
