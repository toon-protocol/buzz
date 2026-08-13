import * as React from "react";

import { useMeshComputeSellCapabilities } from "@/features/mesh-compute/hooks/useMeshComputeSellCapabilities";
import { useMeshComputeSellPricing } from "@/features/mesh-compute/hooks/useMeshComputeSellPricing";
import { useMeshNodeStatus } from "@/features/mesh-compute/hooks/useMeshNodeStatus";
import { resolveMeshComputeSellIngressUrl } from "@/features/mesh-compute/lib/meshComputeSellCapabilities";
import {
  type MeshComputeJobRequest,
  parseMeshComputeJobRequest,
} from "@/features/mesh-compute/lib/meshComputeJobRequest";
import {
  matchMeshComputeCapability,
  type MeshComputeRefusalReason,
} from "@/features/mesh-compute/lib/meshComputeJobValidation";
import {
  publishMeshComputeAccepted,
  publishMeshComputeJobResult,
  publishMeshComputeRefused,
} from "@/features/mesh-compute/lib/postMeshComputeJobEvents";
import { runMeshComputeJob } from "@/features/mesh-compute/lib/runMeshComputeJob";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_MESH_COMPUTE_JOB_REQUEST } from "@/shared/constants/kinds";

/**
 * The seller's job loop (buzz#92): subscribe to kind:5098 requests addressed
 * to this seller, validate each against the local sell capabilities/pricing,
 * run it against the local ingress, and publish the kind:7000 feedback the
 * buyer's retry logic needs. Fully automatic — unlike the factory-jobs
 * provider surface (a manual per-job UI, quoting costs money), a mesh-compute
 * job is commodity inference at a posted price with no RFQ round (epic
 * decision 10), so there is no per-job human gate to wait on.
 *
 * Stops short of publishing a "completed" result: that requires the paid,
 * hashlocked kind:7000 `"completed-offer"` (§6.2), which is buzz#93's
 * payment-leg scope. `onCompletion` hands the raw completion text to
 * whatever wires that up next; nothing here writes it to the relay.
 *
 * Encrypted requests (`encrypted: true`, NIP-44-sealed `i` tag per §8.1) are
 * skipped, not misread as plaintext: decrypting a ciphertext addressed to an
 * arbitrary sender's pubkey needs a Rust NIP-44 command this repo does not
 * have yet (only `nip44_decrypt_from_self` exists, for a different shape).
 */
export function useMeshComputeJobServer(
  transport: ToonEventTransport | null,
  myPubkey: string | null,
  onCompletion?: (request: MeshComputeJobRequest, text: string) => void,
): void {
  const { capabilities } = useMeshComputeSellCapabilities();
  const { pricing } = useMeshComputeSellPricing();
  const { status } = useMeshNodeStatus();
  const processedRef = React.useRef<Set<string>>(new Set());

  const capabilitiesRef = React.useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const pricingRef = React.useRef(pricing);
  pricingRef.current = pricing;
  const statusRef = React.useRef(status);
  statusRef.current = status;
  const onCompletionRef = React.useRef(onCompletion);
  onCompletionRef.current = onCompletion;

  React.useEffect(() => {
    if (!transport || !myPubkey) return;

    const handleRequest = async (raw: RelayEvent) => {
      const request = parseMeshComputeJobRequest(raw);
      if (!request) return;
      if (request.encrypted) return;
      if (processedRef.current.has(request.eventId)) return;
      processedRef.current.add(request.eventId);

      // A decline is two events either way — the kind:7000 the buyer's retry
      // logic reads, then the terminal kind:6098 replying to it that closes
      // the job out — whether the seller declined before or after accepting.
      const refuse = async (reason: MeshComputeRefusalReason) => {
        const refused = await publishMeshComputeRefused(
          {
            rootJobId: request.eventId,
            buyerPubkey: request.buyerPubkey,
            reason,
          },
          transport,
        );
        await publishMeshComputeJobResult(
          {
            rootJobId: request.eventId,
            lastEventId: refused.id,
            buyerPubkey: request.buyerPubkey,
            requestEvent: raw,
            outcome: "refused",
          },
          transport,
        );
      };

      const match = matchMeshComputeCapability(
        request,
        capabilitiesRef.current,
        pricingRef.current,
      );

      if (!match.accepted) {
        await refuse(match.reason);
        return;
      }

      await publishMeshComputeAccepted(
        { rootJobId: request.eventId, buyerPubkey: request.buyerPubkey },
        transport,
      );

      const outcome = await runMeshComputeJob({
        request,
        maxTokens: match.maxTokens,
        advertisedMaxTokens: pricingRef.current.maxOutputTokens,
        ingressBaseUrl: resolveMeshComputeSellIngressUrl(statusRef.current),
      });

      if (outcome.kind === "refused") {
        await refuse(outcome.reason);
        return;
      }

      onCompletionRef.current?.(request, outcome.text);
    };

    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;
    void transport
      .subscribeLive(
        {
          kinds: [KIND_MESH_COMPUTE_JOB_REQUEST],
          "#p": [myPubkey],
          limit: 500,
        },
        (event) => {
          void handleRequest(event);
        },
      )
      .then((d) => {
        if (disposed) {
          void d();
          return;
        }
        dispose = d;
      });

    return () => {
      disposed = true;
      void dispose?.();
    };
  }, [transport, myPubkey]);
}
