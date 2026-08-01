import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Transport-seam guard.
 *
 * Every event the desktop app writes goes through the seam in
 * `src/shared/api/eventTransport.ts` so a second transport can be installed
 * without touching call sites (ADR 0001). The relay session still owns the
 * wire-level write verbs, so nothing but the seam's own implementation may
 * call them: a call site that reaches for `relayClient.publishEvent` is
 * hard-wiring itself to the relay again.
 *
 * `subscribeLive` is guarded for the same reason even though it reads rather
 * than writes. A transport that carries writes to a network the app does not
 * read back from is a dead letter box: on TOON the paid write lands on a
 * different relay than the relay session is attached to, so a call site that
 * subscribes through `relayClient` would silently never see its own message.
 * The narrower relay-shaped read verbs (`fetchChannelHistory`,
 * `subscribeToChannel`, the aux backfills) are NOT guarded yet — history
 * paging still goes to buzz-relay's server-assembled window, which a plain
 * NIP-01 REQ cannot reproduce.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const SCRIPT_PATH = "desktop/scripts/check-transport-seam.mjs";

const SCAN_ROOT = "src";
const EXTENSIONS = new Set([".ts", ".tsx"]);

// The relay session's seamed verbs, reachable only through the seam's
// implementation. `ensureConnected` is here because a pre-publish connect is
// part of writing, not reading; `subscribeLive` because a write the app cannot
// read back has not arrived anywhere useful.
const RELAY_WRITE_CALL_RE =
  /\brelayClient\.(publishEvent|publishEphemeralEvent|ensureConnected|isWritable|subscribeLive)\s*\(/;

// Only the seam's relay implementation may drive those verbs. Tests are
// skipped: mocking the delegate is how the seam's wiring is asserted.
const ALLOWED_FILES = new Set([
  "src/shared/api/relayEventTransport.ts",
  // `ReadStateManager` is constructed with a `RelayClient` and reads through
  // it (`fetchEvents` + `subscribeLive`); it issues none of the write verbs.
  // Moving it onto the seam means replacing that constructor dependency with
  // a narrower one, the same per-instance form `readOnlyRelayClient` needs —
  // see the note in `eventTransport.ts`.
  "src/features/channels/readState/readStateManager.ts",
]);

async function walkFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
    }),
  );
  return files.flat();
}

const violations = [];

for (const filePath of await walkFiles(path.join(projectRoot, SCAN_ROOT))) {
  const relativePath = path
    .relative(projectRoot, filePath)
    .split(path.sep)
    .join("/");

  if (!EXTENSIONS.has(path.extname(filePath))) continue;
  if (ALLOWED_FILES.has(relativePath)) continue;
  if (relativePath.includes(".test.")) continue;

  const content = await fs.readFile(filePath, "utf8");
  content.split("\n").forEach((line, index) => {
    if (RELAY_WRITE_CALL_RE.test(line)) {
      violations.push({
        key: `${relativePath}:${index + 1}`,
        line: line.trim(),
      });
    }
  });
}

if (violations.length > 0) {
  console.error(
    `Desktop: found ${violations.length} write(s) that bypass the transport seam.\n` +
      `Publish through shared/api/eventTransport (or a shared/api/eventWrites helper) instead of the relay client.\n` +
      `A genuinely transport-level caller belongs in ALLOWED_FILES in ${SCRIPT_PATH}.\n`,
  );
  for (const violation of violations) {
    console.error(`  ${violation.key}: ${violation.line}`);
  }
  process.exit(1);
}
