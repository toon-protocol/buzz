import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rust-side transport-seam guard (buzz#27).
 *
 * Mirrors `check-transport-seam.mjs`, which keeps every desktop TS write
 * behind `shared/api/eventTransport.ts`. The Tauri/Rust side has the same
 * shape of problem: `event_transport::dispatch` (`src-tauri/src/event_transport/mod.rs`)
 * is now the one place a signed event is handed to the NIP-98 HTTP relay
 * path or the TOON bridge. Before buzz#27, four call sites hand-rolled the
 * identical `build_nip98_auth_header[_for_keys]` + `POST /events` themselves
 * (`relay::sync_managed_agent_profile`, the two `submit_engram_event`
 * twins, and the huddle STT pipeline) and never reached a second transport.
 *
 * Building the NIP-98 auth header is the tell that a site is about to
 * submit a signed event on its own, bypassing whichever transport is
 * active — so a call to `build_nip98_auth_header`/`build_nip98_auth_header_for_keys`
 * outside the seam's own implementation is exactly that mistake recurring.
 * `POST /query` (a read) legitimately authenticates with the same helper and
 * is out of scope for this guard.
 *
 * This is a fast, no-Rust-toolchain-required approximation for the
 * `desktop-check` gate. The precise, exhaustive guard — an exact per-file
 * count of every `/events` URL-construction site and every guard call, which
 * catches drift this regex-based scan cannot (e.g. a new site added inside
 * `relay.rs`, which this script allowlists wholesale because it also
 * legitimately builds the header for `/query` reads) — is the Rust test
 * `events_url_inventory_is_fully_guarded` in `src-tauri/src/egress_guard_tests.rs`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const SCRIPT_PATH = "desktop/scripts/check-rust-transport-seam.mjs";
const SCAN_ROOT = "src-tauri/src";
const EXTENSION = ".rs";

// A CALL to `build_nip98_auth_header(` / `build_nip98_auth_header_for_keys(`.
// The only two `fn` DEFINITIONS matching this pattern live in `relay.rs`,
// which is allowlisted below, so no separate definition-line exclusion is
// needed here — one was tried and dropped: a line combining a `fn` keyword
// with a real call elsewhere on the same line (e.g. a one-line function body)
// would have silently skipped it.
const AUTH_HEADER_CALL_RE = /\bbuild_nip98_auth_header(?:_for_keys)?\s*\(/;

const ALLOWED_FILES = new Set([
  // The seam's only production submission path — the whole point of this
  // guard is to keep every OTHER write funnelled through here.
  "src-tauri/src/event_transport/relay_http.rs",
  // `build_nip98_auth_header`/`_for_keys` are DEFINED here, and also called
  // legitimately for `POST /query` (a read, not on this seam) by
  // `query_relay_at`/`query_relay_at_with_keys`. After buzz#27 those are the
  // only calls left in this file — the exact, per-file-exhaustive version of
  // that claim is `egress_guard_tests.rs`'s inventory test, not this script.
  "src-tauri/src/relay.rs",
  // Test-only: builds a header to assert admission-gate timing, never sends
  // it anywhere.
  "src-tauri/src/relay_admission.rs",
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

function isTestFile(relativePath) {
  return (
    relativePath.endsWith("_tests.rs") ||
    relativePath.endsWith("/tests.rs") ||
    relativePath.includes("/tests/")
  );
}

const violations = [];

for (const filePath of await walkFiles(path.join(projectRoot, SCAN_ROOT))) {
  const relativePath = path
    .relative(projectRoot, filePath)
    .split(path.sep)
    .join("/");

  if (!relativePath.endsWith(EXTENSION)) continue;
  if (ALLOWED_FILES.has(relativePath)) continue;
  if (isTestFile(relativePath)) continue;

  const content = await fs.readFile(filePath, "utf8");
  content.split("\n").forEach((line, index) => {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("//")) return;
    if (AUTH_HEADER_CALL_RE.test(line)) {
      violations.push({
        key: `${relativePath}:${index + 1}`,
        line: trimmedLine,
      });
    }
  });
}

if (violations.length > 0) {
  console.error(
    `Rust: found ${violations.length} signed-event submission(s) that bypass the write seam.\n` +
      "Build a SignedEventSubmission and call event_transport::dispatch(...) instead of " +
      "hand-rolling build_nip98_auth_header + POST /events.\n" +
      `A genuinely transport-level caller belongs in ALLOWED_FILES in ${SCRIPT_PATH}.\n`,
  );
  for (const violation of violations) {
    console.error(`  ${violation.key}: ${violation.line}`);
  }
  process.exit(1);
}
