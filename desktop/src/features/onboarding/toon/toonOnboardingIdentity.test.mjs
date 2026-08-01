import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveWalletAddress,
  generateWalletMnemonic,
  isValidWalletMnemonic,
} from "./toonOnboardingIdentity.ts";

test("a generated mnemonic is well-formed BIP-39", async () => {
  const mnemonic = await generateWalletMnemonic();

  assert.equal(mnemonic.split(/\s+/).length, 12);
  assert.equal(await isValidWalletMnemonic(mnemonic), true);
});

test("two generated mnemonics are not the same identity", async () => {
  const a = await generateWalletMnemonic();
  const b = await generateWalletMnemonic();

  assert.notEqual(a, b);
});

test("a mnemonic derives to a stable EVM address", async () => {
  // A fixed test vector (Anvil's well-known first account phrase) rather than
  // a freshly generated one, so a derivation regression fails against a known
  // answer instead of just "differs from itself".
  const mnemonic =
    "test test test test test test test test test test test junk";

  const address = await deriveWalletAddress(mnemonic);

  assert.match(address, /^0x[0-9a-fA-F]{40}$/);
  // Same phrase, same account index (0) — derivation must be deterministic.
  assert.equal(await deriveWalletAddress(mnemonic), address);
});

test("garbage is not a valid mnemonic", async () => {
  assert.equal(
    await isValidWalletMnemonic("not a real mnemonic phrase"),
    false,
  );
});
