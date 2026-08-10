import { Buffer } from "buffer";

/**
 * Global `Buffer` polyfill (buzz#135), imported once for its side effect
 * (`main.tsx`) before any factory-job code can run.
 *
 * `@toon-protocol/rig`'s `decryptIncrementArtifact` (the buyer decrypt tail)
 * and `payIncrementOffer` reference the bare Node global `Buffer` — no
 * import, no browser build. A Vite/Tauri webview never defines it, so the
 * first decrypt throws `ReferenceError: Buffer is not defined`. `buffer` is
 * the standard browser-safe polyfill (already a transitive dependency of
 * the TOON stack) and is API-compatible with the calls rig makes
 * (`Buffer.from(str, "hex" | "base64")`, `.toString("hex")`).
 */

type GlobalWithBuffer = typeof globalThis & { Buffer?: typeof Buffer };

const globalWithBuffer = globalThis as GlobalWithBuffer;
if (globalWithBuffer.Buffer === undefined) {
  globalWithBuffer.Buffer = Buffer;
}
