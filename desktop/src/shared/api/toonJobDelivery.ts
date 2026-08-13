import type { ClientJobDeliveryPort } from "@toon-protocol/rig";

/**
 * The factory-job halves of the paid writer (buzz#85, buzz#135) — both sides
 * of `docs/factory-job-protocol.md` §4.2's hashlock join as `ToonPaidWriter`
 * touches them: the provider-session delivery port (key release) and the
 * buyer-side payment receipt/copy (key receipt). Split out of
 * `toonPaidWriter.ts` to keep that module at its size budget.
 */

/**
 * The provider-session delivery port (buzz#135) — `@toon-protocol/rig`'s
 * `ClientJobDeliveryPort`, narrowed to the three members this app drives.
 * One port instance per `ToonPaidWriter`, constructed BEFORE the client so
 * its `handleJob` can be registered as `ToonClientConfig.jobHandler` — the
 * only path that ever releases an increment's decryption key, and it
 * releases exactly the one the buyer's PREPARE paid for (§4.2 of
 * `docs/factory-job-protocol.md`, toon-meta).
 */
export type ProviderJobDeliveryPort = Pick<
  ClientJobDeliveryPort,
  "handleJob" | "encryptArtifact" | "waitForPayment"
>;

/**
 * Construct the real port. `@toon-protocol/rig` is imported lazily for the
 * same reason `toonPaidWriter.ts` lazy-imports `@toon-protocol/client`: the
 * relay transport is the default, and an app that never pays should not
 * load the stack.
 */
export async function createProviderJobDeliveryPort(): Promise<ProviderJobDeliveryPort> {
  const { ClientJobDeliveryPort } = await import("@toon-protocol/rig");
  return new ClientJobDeliveryPort();
}

/**
 * Why an HTTP-only transport can never deliver (buzz#135's BTP gate): the
 * connector originates the buyer's paying PREPARE as a server-originated
 * BTP MESSAGE (toon-client#494), so without a BTP session there is no wire
 * the key release could ride. Quoting — an ordinary paid relay write —
 * still works.
 */
export const JOB_DELIVERY_NEEDS_BTP_MESSAGE =
  "Increment delivery needs the connector's BTP session — this transport runs one-shot ILP-over-HTTP (BUZZ_TOON_BTP_URL=off), which can quote but never release an artifact key.";

/**
 * What paying one factory-job increment (buzz#85) settles: the fulfillment
 * IS the artifact's decryption key, per §4.2 — revealing it to satisfy the
 * hashlock and handing the buyer the key are the same act, in the same
 * packet.
 */
export type FactoryJobIncrementPaymentReceipt = {
  fulfillmentHex: string;
  channelId: string;
  amount: bigint;
  destination: string;
};

/**
 * Human copy for a THROWN (not merely refused) failure while setting up a
 * factory job increment payment. `@toon-protocol/client` internals — e.g.
 * `ToonClientError`'s "No negotiation metadata for peer…" when the
 * connector's x402 greeting hasn't bootstrapped a route yet — are debugging
 * detail, not something a buyer paying a provider should read raw. The raw
 * error is preserved as `cause` (and console-logged by the caller) for
 * anyone who needs it.
 */
export function describeFactoryJobPaymentSetupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/negotiation metadata/i.test(raw)) {
    return "This provider isn't ready to accept a payment session yet. Wait a moment and try again — if it keeps failing, the provider may be offline.";
  }
  return "Couldn't set up the payment for this increment. Check your connection and try again.";
}
