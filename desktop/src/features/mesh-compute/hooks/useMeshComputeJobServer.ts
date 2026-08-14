import * as React from "react";

import { useMeshComputeSellCapabilities } from "@/features/mesh-compute/hooks/useMeshComputeSellCapabilities";
import { useMeshComputeSellPricing } from "@/features/mesh-compute/hooks/useMeshComputeSellPricing";
import { useMeshNodeStatus } from "@/features/mesh-compute/hooks/useMeshNodeStatus";
import { resolveMeshComputeSellIngressUrl } from "@/features/mesh-compute/lib/meshComputeSellCapabilities";
import { typicalJobCostBaseUnits } from "@/features/mesh-compute/lib/meshComputeSellPricing";
import { parseMeshComputeJobRequest } from "@/features/mesh-compute/lib/meshComputeJobRequest";
import {
  matchMeshComputeCapability,
  type MeshComputeRefusalReason,
} from "@/features/mesh-compute/lib/meshComputeJobValidation";
import {
  publishMeshComputeAccepted,
  publishMeshComputeCompletedOffer,
  publishMeshComputeJobResult,
  publishMeshComputeRefused,
} from "@/features/mesh-compute/lib/postMeshComputeJobEvents";
import { runMeshComputeJob } from "@/features/mesh-compute/lib/runMeshComputeJob";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_MESH_COMPUTE_JOB_FEEDBACK,
  KIND_MESH_COMPUTE_JOB_REQUEST,
} from "@/shared/constants/kinds";

/**
 * The seller's job loop (buzz#92): subscribe to kind:5098 requests addressed
 * to this seller, validate each against the local sell capabilities/pricing,
 * run it against the local ingress, and publish the kind:7000 feedback the
 * buyer's retry logic needs — then the §6.2 `completed-offer` carrying the
 * completion itself, encrypted, inline. Fully automatic — unlike the
 * factory-jobs provider surface (a manual per-job UI, quoting costs money),
 * a mesh-compute job is commodity inference at a posted price with no RFQ
 * round (epic decision 10), so there is no per-job human gate to wait on.
 *
 * The success terminal stops at the published offer: the kind:6098
 * `outcome:"completed"` result is DEFINED as "the completed-offer was paid"
 * (§9.3), and answering the buyer's paying PREPARE with the key is buzz#93's
 * payment leg — so no terminal result can honestly publish here yet, and the
 * staged key is not yet armed for release.
 *
 * Guards the review demanded (PR #199):
 * - Runs only while the mesh node is actually serving (`mode:"serve"`,
 *   `state:"running"`) and the transport's BTP session can ever release a
 *   key (`supportsJobDelivery()`) — a seller that could never deliver must
 *   not accept, and a non-selling desktop must not spend paid writes
 *   refusing jobs it never advertised for.
 * - Before subscribing, fetches this seller's own prior kind:7000 feedback
 *   and seeds the processed set with every answered root job id (the
 *   `useInboundFactoryJobs` `alreadyQuoted` pattern) — so the live REQ's
 *   stored-event replay, a remount, or a community switch never re-answers
 *   (or re-generates) an already-answered job.
 * - Bounds the replay with `since`: a stored request older than the horizon
 *   is a buyer whose retry logic gave up long ago; serving it is unpaid
 *   generation for nobody (the issue's "cap generation" gotcha).
 *
 * Encrypted requests (`encrypted: true`, NIP-44-sealed `i` tag per §8.1) are
 * skipped, not misread as plaintext: decrypting a ciphertext addressed to an
 * arbitrary sender's pubkey needs a Rust NIP-44 command this repo does not
 * have yet (only `nip44_decrypt_from_self` exists, for a different shape).
 */

/** How far back the live subscription may replay stored requests. */
const SERVE_REPLAY_HORIZON_SECONDS = 15 * 60;

/**
 * §6.2's relay write cap: 64 KB advertised in NIP-11. A completion whose
 * base64 ciphertext exceeds it MUST be refused rather than truncated.
 */
const OFFER_CONTENT_MAX_CHARS = 64 * 1024;

/** Browser-safe bytes → base64 (no Node Buffer in the renderer). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function useMeshComputeJobServer(
  transport: ToonEventTransport | null,
  myPubkey: string | null,
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

  // A boolean, not the status object: the status poll produces a fresh
  // object every few seconds, and putting it in the effect deps would tear
  // the subscription down and replay it on every poll.
  const isServing = status?.mode === "serve" && status?.state === "running";

  React.useEffect(() => {
    if (!transport || !myPubkey || !isServing) return;
    // Without a BTP session no PREPARE can ever reach this client to release
    // a completion key (`toonJobDelivery.ts`'s gate) — accepting jobs the
    // seller could never be paid for helps nobody, so don't subscribe.
    if (!transport.getPaidWriter().supportsJobDelivery()) return;

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

      const accepted = await publishMeshComputeAccepted(
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

      // §6.2: the completion goes back encrypted, inline, in a kind:7000
      // completed-offer — the completion path buzz#93's payment leg (arming
      // the key release, §7 steps 3–7) layers on top of. The port is per
      // §6.1 the one place `sha256(key)` is derived.
      const port = await transport.getPaidWriter().getJobDeliveryPort();
      const encrypted = await port.encryptArtifact(
        new TextEncoder().encode(outcome.text),
      );
      const ciphertextBase64 = bytesToBase64(encrypted.ciphertext);
      if (ciphertextBase64.length > OFFER_CONTENT_MAX_CHARS) {
        // §6.2: refuse, never truncate. "context-exceeded" is the closest of
        // the taxonomy's three reasons — the output outgrew what one relay
        // event can carry.
        await refuse("context-exceeded");
        return;
      }

      // Priced at the request's own public `max_tokens` × the posted
      // per-1k-output-token rate — derivable by the buyer from public
      // information (§6.2), which per-actual-token pricing cannot yet be
      // (the ingress reports no usage, and the content is ciphertext).
      const amountMicroUsdc = typicalJobCostBaseUnits(
        pricingRef.current.priceMicroUsdcPer1kTokens,
        request.maxTokens,
      );
      await publishMeshComputeCompletedOffer(
        {
          rootJobId: request.eventId,
          acceptedEventId: accepted.id,
          buyerPubkey: request.buyerPubkey,
          amountMicroUsdc,
          conditionHex: encrypted.conditionHex,
          ciphertextBase64,
        },
        transport,
      );
    };

    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;

    const start = async () => {
      // Answered-jobs guard FIRST, then subscribe — the live REQ replays
      // stored requests immediately, so subscribing before the prior-answer
      // set is seeded would re-serve them in the gap.
      const priorFeedback = await transport.fetchEvents({
        kinds: [KIND_MESH_COMPUTE_JOB_FEEDBACK],
        authors: [myPubkey],
        limit: 500,
      });
      if (disposed) return;
      for (const event of priorFeedback) {
        const rootId = event.tags.find(
          (tag) => tag[0] === "e" && tag[3] === "root",
        )?.[1];
        if (rootId) processedRef.current.add(rootId);
      }

      const d = await transport.subscribeLive(
        {
          kinds: [KIND_MESH_COMPUTE_JOB_REQUEST],
          "#p": [myPubkey],
          since: Math.floor(Date.now() / 1000) - SERVE_REPLAY_HORIZON_SECONDS,
          limit: 500,
        },
        (event) => {
          handleRequest(event).catch((error) => {
            console.error("[mesh-compute] job handling failed", error);
          });
        },
      );
      if (disposed) {
        void d();
        return;
      }
      dispose = d;
    };

    start().catch((error) => {
      console.error("[mesh-compute] job server failed to start", error);
    });

    return () => {
      disposed = true;
      void dispose?.();
    };
  }, [transport, myPubkey, isServing]);
}
