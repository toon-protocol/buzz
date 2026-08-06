import {
  buildIncrementOfferEvent,
  buildNarrationEvent,
  buildResultEvent,
} from "@toon-protocol/rig";

import {
  asSignableTemplate,
  toRigFactoryJobRequest,
  toRigMilestone,
} from "@/features/providers/lib/factoryJobDeliveryEvents";
import type { FactoryJobRequest } from "@/features/factory-jobs/lib/factoryJobRequest";
import { signRelayEvent } from "@/shared/api/tauri";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The provider's delivery verbs (buzz#135) — the §4–§6 half of
 * `docs/factory-job-protocol.md` (toon-meta) that runs AFTER a quote:
 * offer an increment (encrypt → upload ciphertext → publish `partial` →
 * wait for the paying PREPARE), narrate progress for free, and publish the
 * terminal kind:6097 result.
 *
 * Every event is built by `@toon-protocol/rig`'s proven builders, signed by
 * the same Tauri `signRelayEvent` + transport-seam path as
 * `postFactoryJobQuote.ts`, and published as an ordinary paid relay write.
 * The one non-relay leg is the ciphertext upload, which rides the existing
 * paid store route (`ToonPaidWriter.uploadBlob` → `g.toon.ario`, the
 * `storeMediaUploader.ts` precedent) — only ever the ciphertext, never the
 * plaintext: the key is released exclusively as the ILP fulfillment of the
 * buyer's payment (§4.2), by the delivery port this module gets from
 * `ToonPaidWriter.getJobDeliveryPort()`.
 *
 * One increment in flight at a time — the port's own sequential contract:
 * `encryptArtifact` stages a key and only `waitForPayment` for that same
 * condition arms the release, so overlapping deliveries would disarm each
 * other. Callers (`useProviderDelivery`) serialize.
 */

export type FactoryJobIncrementInput = {
  job: FactoryJobRequest;
  /** The quote's event id for increment 1; the previous offer's for n ≥ 2 (§4.1). */
  parentEventId: string;
  increment: {
    n: number;
    of: number;
    milestone: string;
    priceUsdcBaseUnits: bigint;
  };
  artifactBytes: Uint8Array;
};

export type FactoryJobIncrementDelivery = {
  /** The published kind:7000 `status:"partial"` offer. */
  offerEvent: RelayEvent;
  /** Where the ciphertext now permanently lives. */
  artifactTxId: string;
  /** `sha256(key)` — the offer's `condition` tag, for the terminal result's bookkeeping. */
  conditionHex: string;
  /** `true` once the buyer's PREPARE released the key; `false` when the port's payment window elapsed unpaid. */
  paid: boolean;
};

/**
 * Deliver one increment: encrypt under a fresh single-use key, upload ONLY
 * the ciphertext, publish the spec-compliant offer, then wait for payment.
 * Resolving `{paid: false}` is a protocol outcome (the buyer walked away —
 * §5.2 `abandoned-buyer`), not an error; everything before the wait throws
 * on failure, since an offer that never published has nothing to wait on.
 */
export async function deliverFactoryJobIncrement(
  input: FactoryJobIncrementInput,
  transport: ToonEventTransport,
  onOfferPublished?: (offerEvent: RelayEvent) => void,
): Promise<FactoryJobIncrementDelivery> {
  const writer = transport.getPaidWriter();
  // Resolve the port FIRST — on an HTTP-only transport this throws the
  // BTP-gate reason before any money is spent on an upload the provider
  // could never collect on.
  const port = await writer.getJobDeliveryPort();

  const encrypted = await port.encryptArtifact(input.artifactBytes);
  const { txId } = await writer.uploadBlob(
    encrypted.ciphertext,
    "application/octet-stream",
  );

  const template = buildIncrementOfferEvent({
    job: toRigFactoryJobRequest(input.job),
    parentEventId: input.parentEventId,
    increment: {
      n: input.increment.n,
      of: input.increment.of,
      milestone: toRigMilestone(input.increment.milestone),
      priceUsdc: input.increment.priceUsdcBaseUnits.toString(),
    },
    artifact: {
      arweaveTxId: txId,
      ciphertextSha256: encrypted.ciphertextSha256,
      conditionHex: encrypted.conditionHex,
    },
  });
  const offerEvent = await signRelayEvent(asSignableTemplate(template));
  await transport.publish(offerEvent, {
    timeoutMessage: "Timed out while publishing the increment offer.",
    sendErrorMessage: "Failed to publish the increment offer.",
  });
  onOfferPublished?.(offerEvent);

  const paid = await port.waitForPayment({
    offerEventId: offerEvent.id,
    conditionHex: encrypted.conditionHex,
    priceUsdc: input.increment.priceUsdcBaseUnits.toString(),
  });

  return {
    offerEvent,
    artifactTxId: txId,
    conditionHex: encrypted.conditionHex,
    paid,
  };
}

/** Publish a free §6 narration event — no artifact, nothing to pay against. */
export async function publishFactoryJobNarration(
  input: { job: FactoryJobRequest; parentEventId: string; message: string },
  transport: ToonEventTransport,
): Promise<RelayEvent> {
  const template = buildNarrationEvent({
    job: toRigFactoryJobRequest(input.job),
    parentEventId: input.parentEventId,
    message: input.message,
  });
  const event = await signRelayEvent(asSignableTemplate(template));
  return transport.publish(event, {
    timeoutMessage: "Timed out while sending the update.",
    sendErrorMessage: "Failed to send the update.",
  });
}

/**
 * Publish the terminal kind:6097 result (§5). This surface only ever reaches
 * two of the three outcomes: `completed` (every quoted increment paid) and
 * `abandoned-buyer` (the payment window elapsed on an offered increment) —
 * `abandoned-provider` is the outcome of a provider walking away mid-job,
 * which an interactive delivery surface records by simply not delivering.
 */
export async function publishFactoryJobResult(
  input: {
    job: FactoryJobRequest;
    /** The original kind:5097 event, verbatim — the result's `request` tag (§5.1). */
    requestEvent: RelayEvent;
    /** The last kind:7000 event in the thread (offer or narration). */
    lastEventId: string;
    outcome: "completed" | "abandoned-buyer";
    reachedIncrement: number;
    totalIncrements: number;
    /** Required exactly when `outcome` is `completed` (§5.1's `i` tag). */
    finalArtifactTxId?: string;
  },
  transport: ToonEventTransport,
): Promise<RelayEvent> {
  const template = buildResultEvent({
    job: toRigFactoryJobRequest(input.job),
    requestEvent: input.requestEvent,
    lastEventId: input.lastEventId,
    outcome: input.outcome,
    reachedIncrement: input.reachedIncrement,
    totalIncrements: input.totalIncrements,
    ...(input.finalArtifactTxId !== undefined
      ? { finalArtifact: { arweaveTxId: input.finalArtifactTxId } }
      : {}),
  });
  const event = await signRelayEvent(asSignableTemplate(template));
  return transport.publish(event, {
    timeoutMessage: "Timed out while publishing the job result.",
    sendErrorMessage: "Failed to publish the job result.",
  });
}
