/**
 * Payment-identity generation for the TOON onboarding wizard.
 *
 * `@toon-protocol/client` is imported lazily — same reason `toonPaidWriter.ts`
 * does it: it pulls in viem and the settlement stack, and the wizard only
 * runs when `BUZZ_TRANSPORT=toon`, so an app that never switches to TOON
 * should not pay for the chunk.
 *
 * Always account index 0. The wizard generates one wallet per identity; a
 * user who wants a non-default account index already has the manual path
 * (`BUZZ_TOON_MNEMONIC` / `BUZZ_TOON_ACCOUNT_INDEX` in the environment,
 * documented in `desktop/README.md`), which wins over anything stored here
 * (see `transportSelection.ts`).
 */

const WIZARD_ACCOUNT_INDEX = 0;

/** A fresh BIP-39 mnemonic for a new payment identity. */
export async function generateWalletMnemonic(): Promise<string> {
  const { generateMnemonic } = await import("@toon-protocol/client");
  return generateMnemonic();
}

/** Whether `mnemonic` is well-formed BIP-39 (checksum included). */
export async function isValidWalletMnemonic(
  mnemonic: string,
): Promise<boolean> {
  const { validateMnemonic } = await import("@toon-protocol/client");
  return validateMnemonic(mnemonic.trim());
}

/** The EVM settlement address a mnemonic derives to — a pure, local, offline computation. */
export async function deriveWalletAddress(mnemonic: string): Promise<string> {
  const { deriveFullIdentity } = await import("@toon-protocol/client");
  const identity = await deriveFullIdentity(mnemonic, WIZARD_ACCOUNT_INDEX);
  return identity.evm.address;
}
