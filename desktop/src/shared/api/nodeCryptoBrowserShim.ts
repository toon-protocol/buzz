import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Vite-aliased stand-in for Node's `crypto` module (buzz#135).
 *
 * `@toon-protocol/rig`'s `ClientJobDeliveryPort.encryptArtifact` calls
 * `createHash("sha256").update(ciphertext).digest("hex")` — a bare Node API
 * with no browser build. Left unaliased, Vite externalizes the bare
 * `"crypto"` specifier to an empty stub object for the browser, so that call
 * throws `TypeError: createHash is not a function` the moment a provider
 * delivers an increment.
 *
 * Aliasing the bare specifier is global, not per-importer, so every other
 * package in the dependency graph that also imports from `"crypto"` must
 * resolve against this same file or the build's static linking fails —
 * regardless of whether that importer's code path is ever reachable from the
 * desktop app. Each export below is documented with which package needs it
 * and whether it is real (implemented via `@noble/hashes`/`Crypto.randomUUID`,
 * the same browser-safe primitives `channelMediaCrypto.ts` already uses) or a
 * throwing stub for a Node-only path the desktop app never takes — same
 * posture as `minaUnavailable.ts`.
 */

class BrowserHash {
  private readonly chunks: Uint8Array[] = [];

  update(data: Uint8Array | string): this {
    this.chunks.push(
      typeof data === "string" ? new TextEncoder().encode(data) : data,
    );
    return this;
  }

  digest(encoding: "hex"): string {
    if (encoding !== "hex") {
      throw new Error(
        `nodeCryptoBrowserShim: unsupported digest encoding "${encoding}" (only "hex" is implemented)`,
      );
    }
    let totalLength = 0;
    for (const chunk of this.chunks) totalLength += chunk.length;
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return bytesToHex(sha256(merged));
  }
}

export function createHash(algorithm: string): BrowserHash {
  if (algorithm !== "sha256") {
    throw new Error(
      `nodeCryptoBrowserShim: unsupported hash algorithm "${algorithm}" (only "sha256" is implemented)`,
    );
  }
  return new BrowserHash();
}

/** `@toon-protocol/sdk` also imports Node's `crypto.randomUUID` directly — the standard `Crypto.randomUUID()` browsers ship natively covers it. */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Same posture as `minaUnavailable.ts`: throw loudly and traceably, naming
 * the unreachable path, rather than reimplement Node-only crypto nothing in
 * the desktop app ever calls.
 */
function unsupported(name: string, reachedFrom: string): never {
  throw new Error(
    `nodeCryptoBrowserShim: "${name}" is not implemented — ${reachedFrom} is not reachable from the Buzz desktop app.`,
  );
}

/**
 * `@toon-protocol/client`'s Node-only keystore backup/export path
 * (`keystore-node.ts`) statically imports these four from `crypto`. Nothing
 * in the Buzz desktop app calls `loadKeystore`/`writeKeystoreFile`/
 * `generateKeystore`/`importKeystore` (confirmed unreachable), but aliasing
 * `crypto` for the app's real uses above (createHash, randomUUID) means this
 * file must still satisfy every named import anywhere in the dependency
 * graph, or the build's static linking fails.
 */
const KEYSTORE_NODE_PATH =
  "@toon-protocol/client's Node-only keystore backup path";

export function scryptSync(): never {
  return unsupported("scryptSync", KEYSTORE_NODE_PATH);
}

export function createCipheriv(): never {
  return unsupported("createCipheriv", KEYSTORE_NODE_PATH);
}

export function createDecipheriv(): never {
  return unsupported("createDecipheriv", KEYSTORE_NODE_PATH);
}

export function randomBytes(): never {
  return unsupported("randomBytes", KEYSTORE_NODE_PATH);
}

/**
 * `@noble/ed25519@1.6.1` (a transitive Arweave-signing dependency) imports
 * Node's `crypto` as a default import and only ever falls back to it —
 * `crypto.node` — when the browser's own `self.crypto` (`crypto.web`) is
 * unavailable. Tauri's webview always exposes `self.crypto`, so that
 * fallback branch never runs; `undefined` here is the correct value, not a
 * stub.
 */
export default undefined;

/**
 * `@dha-team/arbundles`'s RSA-PSS-4096 Arweave signer (one of several signer
 * types that package supports) statically imports both from `crypto`. Buzz's
 * Arweave uploads settle over EVM/Solana, never an Arweave-native RSA wallet,
 * so this signer class is never constructed. `constants` only needs to exist
 * as an object — its properties are read inside the unreachable `sign()`
 * method, never at module load.
 */
export const constants = {};

export function createSign(): never {
  return unsupported(
    "createSign",
    "@dha-team/arbundles's RSA-PSS-4096 Arweave signer",
  );
}
