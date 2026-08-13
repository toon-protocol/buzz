import { decode as decodeNip19 } from "nostr-tools/nip19";

import { getNsec } from "@/shared/api/tauriIdentity";

/**
 * Asks Rust for the user's secret key so the renderer can do a NIP-59 gift
 * wrap's two NIP-44 layers itself — a plain signature (`sign_event`) is not
 * enough, since a seal is an ECDH encryption to the recipient under the
 * *sender's* key, not a signature over anything.
 *
 * buzz#43 gave the channel-key gift-wrap paths (`channelKeyInbox.ts`,
 * `channelKeyRotation.ts`, `channelMembership.ts`) Rust-side `seal_gift_wrap`/
 * `unseal_gift_wrap` commands that do this ECDH in Rust instead, so this
 * function's only remaining callers are the factory-jobs gift-wrap flow
 * (`postFactoryJob.ts`, `useInboundFactoryJobs.ts`) — porting that pair to
 * the same commands is a natural follow-up, out of buzz#43's scope (it is a
 * different rumor shape and a different feature).
 *
 * Deliberately not cached. A key held in a module-level variable outlives the
 * screen that needed it and shows up in every heap snapshot taken afterwards;
 * an IPC round-trip per wrap is not a cost worth trading that for.
 */
export async function getIdentitySecretKey(): Promise<Uint8Array> {
  const nsec = await getNsec();
  const decoded = decodeNip19(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("The stored identity is not an nsec.");
  }
  return decoded.data;
}
