import assert from "node:assert/strict";
import test from "node:test";

import {
  MESH_COMPUTE_SELL_INGRESS_BASE_URL,
  parseMaxVramGbInput,
  resolveMeshComputeSellIngressUrl,
} from "./meshComputeSellCapabilities.ts";

// ── ingress URL (buzz#173 AC3/AC5) ───────────────────────────────────────
// mesh_llm/mod.rs pins MESH_LOOPBACK_HOST to 127.0.0.1 and DEFAULT_MESH_API_PORT
// to 9337 regardless of admission mode. This constant mirrors that value so a
// future job handler has something to read before any node has ever started.

test("MESH_COMPUTE_SELL_INGRESS_BASE_URL stays on loopback", () => {
  assert.equal(MESH_COMPUTE_SELL_INGRESS_BASE_URL, "http://127.0.0.1:9337/v1");
});

test("resolveMeshComputeSellIngressUrl prefers a live serving status", () => {
  const url = resolveMeshComputeSellIngressUrl({
    mode: "serve",
    state: "running",
    apiBaseUrl: "http://127.0.0.1:19337/v1",
  });
  assert.equal(url, "http://127.0.0.1:19337/v1");
});

test("resolveMeshComputeSellIngressUrl falls back to the known default when nothing is running", () => {
  assert.equal(
    resolveMeshComputeSellIngressUrl(null),
    MESH_COMPUTE_SELL_INGRESS_BASE_URL,
  );
  assert.equal(
    resolveMeshComputeSellIngressUrl({
      mode: null,
      state: "off",
      apiBaseUrl: null,
    }),
    MESH_COMPUTE_SELL_INGRESS_BASE_URL,
  );
});

test("resolveMeshComputeSellIngressUrl ignores a client-mode (consuming) runtime's URL", () => {
  // A client-mode runtime's apiBaseUrl is where THIS machine reaches a peer's
  // compute, not where a job handler would reach this machine's own serving.
  const url = resolveMeshComputeSellIngressUrl({
    mode: "client",
    state: "running",
    apiBaseUrl: "http://127.0.0.1:9337/v1",
  });
  assert.equal(url, MESH_COMPUTE_SELL_INGRESS_BASE_URL);
});

test("resolveMeshComputeSellIngressUrl never returns a non-loopback URL even if status lies", () => {
  const url = resolveMeshComputeSellIngressUrl({
    mode: "serve",
    state: "running",
    apiBaseUrl: "http://0.0.0.0:9337/v1",
  });
  assert.equal(url, MESH_COMPUTE_SELL_INGRESS_BASE_URL);
});

// ── VRAM ceiling parsing ──────────────────────────────────────────────────

test("parseMaxVramGbInput accepts a positive number, including decimals", () => {
  assert.equal(parseMaxVramGbInput("24"), 24);
  assert.equal(parseMaxVramGbInput("11.5"), 11.5);
});

test("parseMaxVramGbInput tolerates surrounding whitespace", () => {
  assert.equal(parseMaxVramGbInput("  8 "), 8);
});

test("parseMaxVramGbInput rejects zero, negatives, and junk", () => {
  assert.equal(parseMaxVramGbInput("0"), null);
  assert.equal(parseMaxVramGbInput("-1"), null);
  assert.equal(parseMaxVramGbInput("abc"), null);
  assert.equal(parseMaxVramGbInput(""), null);
  assert.equal(parseMaxVramGbInput("  "), null);
  assert.equal(parseMaxVramGbInput("NaN"), null);
});
