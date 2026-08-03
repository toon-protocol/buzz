import { wrapEvent } from "nostr-tools/nip59";

import {
  buildFactoryJobRequest,
  type FactoryJobRequestInput,
} from "@/features/factory-jobs/lib/factoryJobRequest";
import { getIdentitySecretKey } from "@/shared/api/identitySecretKey";
import { signRelayEvent } from "@/shared/api/tauri";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Posting a job (buzz#85 "What" §1): build the kind:5097 brief, sign it —
 * plain for an open broadcast RFQ, or NIP-59 gift-wrapped when the buyer
 * chooses to (decision 1: the relay sees neither content nor sender) — and
 * publish it as a paid write on the factory job market.
 *
 * Targeting and gift-wrapping are independent choices (spec §2.1/§2.2): a
 * `p` tag alone is a public brief that happens to name one provider, still
 * readable by every other candidate; gift-wrapping is what makes it private,
 * and it only composes with a targeted brief — encrypting to a single
 * recipient is meaningless for an open RFQ, which needs every candidate
 * provider to read the brief to quote on it. `giftWrap: true` without a
 * `targetProviderPubkey` is therefore rejected rather than silently posted
 * in the open.
 */

/**
 * Wrap a job request rumor for one provider. Reuses `nostr-tools/nip59`
 * unchanged, same as `channelKeyDelivery.wrapChannelKey` — no hand-rolled
 * crypto, just a different rumor shape.
 */
export function wrapFactoryJobRequest(
  rumor: { kind: number; content: string; tags: string[][] },
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
): RelayEvent {
  return wrapEvent(
    rumor,
    senderSecretKey,
    recipientPubkey,
  ) as unknown as RelayEvent;
}

/** Post a job. Publishes on `transport` — the caller resolves this from `factoryJobAvailability`. */
export async function postFactoryJob(
  input: FactoryJobRequestInput,
  transport: ToonEventTransport,
  options?: { giftWrap?: boolean },
): Promise<RelayEvent> {
  const template = buildFactoryJobRequest(input);
  const giftWrap = options?.giftWrap ?? false;
  const targetProviderPubkey = input.targetProviderPubkey;

  if (giftWrap && !targetProviderPubkey) {
    throw new Error(
      "Cannot gift-wrap a job request without a targeted provider.",
    );
  }

  const event =
    giftWrap && targetProviderPubkey
      ? wrapFactoryJobRequest(
          template,
          await getIdentitySecretKey(),
          targetProviderPubkey,
        )
      : await signRelayEvent(template);

  return transport.publish(event, {
    timeoutMessage: "Timed out while posting the job.",
    sendErrorMessage: "Failed to post the job.",
  });
}
