/**
 * Vite-aliased stand-in for Node's `child_process` module (buzz#135).
 *
 * `@toon-protocol/rig`'s package root statically re-exports its git plumbing
 * (`src/repo-reader.ts`, `src/materialize.ts`), and those modules run
 *
 * ```js
 * import { execFile, spawn } from "child_process";
 * import { promisify } from "util";
 * const execFileAsync = promisify(execFile);
 * ```
 *
 * at MODULE SCOPE. Left unaliased, Vite externalizes the bare
 * `"child_process"` specifier to an empty stub for the browser, so `execFile`
 * is `undefined` and `promisify(undefined)` throws
 * `TypeError: The "original" argument must be of type Function` while the
 * module is still evaluating.
 *
 * That is not a niche failure. `ToonPaidWriter.ensureClient()` constructs the
 * delivery port (`toonJobDelivery.ts`'s `createProviderJobDeliveryPort`,
 * which `await import`s `@toon-protocol/rig`) BEFORE the client, so a
 * throwing rig module load fails EVERY paid-write client start — the Money
 * tab's network-spend read included, which is how this surfaced ("Could not
 * start the TOON client: The \"original\" argument must be of type
 * Function").
 *
 * Buzz never asks rig to read or materialize a git repository — it only uses
 * `ClientJobDeliveryPort` — so nothing here needs a real implementation. It
 * only has to be a *function*, so `promisify` is satisfied and the module
 * graph evaluates. Same posture as `minaUnavailable.ts` and
 * `nodeCryptoBrowserShim.ts`: throw loudly and traceably, naming the
 * unreachable path, rather than reimplement a Node-only API in the browser.
 */

const GIT_PLUMBING_PATH =
  "@toon-protocol/rig's local-git plumbing (repo-reader / materialize)";

function unsupported(name: string): never {
  throw new Error(
    `nodeChildProcessBrowserShim: "${name}" is not implemented — ${GIT_PLUMBING_PATH} is not reachable from the Buzz desktop app.`,
  );
}

export function execFile(): never {
  return unsupported("execFile");
}

export function spawn(): never {
  return unsupported("spawn");
}

export default { execFile, spawn };
