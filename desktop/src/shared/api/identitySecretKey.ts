import { decode as decodeNip19 } from "nostr-tools/nip19";

import { getNsec } from "@/shared/api/tauriIdentity";

/**
 * The one place the renderer asks Rust for the user's secret key.
 *
 * Everything else in the app signs by *sending* Rust an unsigned event
 * (`signRelayEvent` → the `sign_event` command) and getting a signed one back,
 * which is the right shape: the key stays in the keychain-backed Rust side and
 * the webview never holds it.
 *
 * Gift wraps cannot use that path, and it is worth being precise about why.
 * A NIP-59 wrap is not one signature — it is a NIP-44 encryption to the
 * recipient under an ECDH secret derived from the *sender's* key (the seal),
 * wrapped in a second encryption under a throwaway key. `sign_event` signs;
 * it does not do ECDH. Unwrapping is worse: the recipient's key is needed to
 * derive the same shared secret, and there is no "decrypt this for me"
 * command at all. Adding both to the Rust surface is the better long-term
 * answer (buzz#27 gave the Rust side a write seam; a crypto seam is the
 * sequel) — until then this is the honest, single, greppable exception.
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
