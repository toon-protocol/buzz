/**
 * Stand-in for the TOON client's Mina optional dependencies.
 *
 * `@toon-protocol/client` dynamically imports `o1js` and `mina-signer` when a
 * `mina:*` settlement chain is negotiated. Bundling them costs ~15 MB of
 * JavaScript for a code path the desktop app never takes — the transport
 * settles on EVM (and can settle on Solana), never on Mina. Vite aliases both
 * packages to this module so the chunk disappears while the dynamic import
 * still resolves.
 *
 * Any actual use throws rather than misbehaving quietly, so a future Mina
 * settlement chain fails with a message that names the cause.
 */

const MESSAGE =
  "Mina settlement is not bundled into the Buzz desktop app. Set BUZZ_TOON_CHAIN " +
  "to an EVM or Solana chain, or drop the o1js/mina-signer aliases in vite.config.ts.";

function unavailable(): never {
  throw new Error(MESSAGE);
}

export default new Proxy({} as Record<string, unknown>, {
  get: unavailable,
});
