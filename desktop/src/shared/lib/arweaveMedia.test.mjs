import assert from "node:assert/strict";
import test from "node:test";

import {
  arweaveMediaCandidates,
  arweaveMediaUrls,
  getArweaveGateways,
  isArweaveMediaUrl,
  nextArweaveGatewayUrl,
  setArweaveGateways,
} from "./arweaveMedia.ts";

const TX_ID = "hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";

test.afterEach(() => {
  setArweaveGateways(null);
});

test("the default gateway preference is ar.io first", () => {
  assert.equal(getArweaveGateways()[0], "https://ar-io.dev");
});

test("an empty configured list clears rather than disables", () => {
  // A misconfigured env var must not leave the app with nowhere to fetch media.
  setArweaveGateways([]);
  assert.deepEqual(
    [...getArweaveGateways()],
    ["https://ar-io.dev", "https://arweave.net", "https://permagate.io"],
  );
});

test("permaweb URLs are recognised; relay media URLs are not", () => {
  assert.equal(isArweaveMediaUrl(`https://ar-io.dev/${TX_ID}`), true);
  assert.equal(isArweaveMediaUrl(`ar://${TX_ID}`), true);
  assert.equal(
    isArweaveMediaUrl(`https://relay.example/media/${"a".repeat(64)}.png`),
    false,
  );
  assert.equal(isArweaveMediaUrl(undefined), false);
});

test("candidates expand a permaweb URL across every gateway, best first", () => {
  const candidates = arweaveMediaCandidates(`https://arweave.net/${TX_ID}`);
  assert.deepEqual(candidates, [
    `https://ar-io.dev/${TX_ID}`,
    `https://arweave.net/${TX_ID}`,
    `https://permagate.io/${TX_ID}`,
  ]);
});

test("a non-permaweb URL is its own only candidate", () => {
  const url = "https://relay.example/media/abc.png";
  assert.deepEqual(arweaveMediaCandidates(url), [url]);
});

test("the upload stamp uses the configured primary and lists the rest as mirrors", () => {
  setArweaveGateways(["https://permagate.io", "https://arweave.net"]);
  assert.deepEqual(arweaveMediaUrls(TX_ID), {
    url: `https://permagate.io/${TX_ID}`,
    fallbacks: [`https://arweave.net/${TX_ID}`],
  });
});

test("a failed gateway rotates to the next one, then gives up", () => {
  const primary = `https://ar-io.dev/${TX_ID}`;
  const second = `https://arweave.net/${TX_ID}`;
  const third = `https://permagate.io/${TX_ID}`;

  assert.equal(nextArweaveGatewayUrl(primary, primary), second);
  assert.equal(nextArweaveGatewayUrl(primary, second), third);
  // Every mirror refused: stop, rather than looping back to the first.
  assert.equal(nextArweaveGatewayUrl(primary, third), null);
});

test("a failure on a URL we never proposed does not restart the rotation", () => {
  // Otherwise a relay-proxied rewrite that 404s would spin forever.
  assert.equal(
    nextArweaveGatewayUrl(`https://ar-io.dev/${TX_ID}`, "http://127.0.0.1:9/x"),
    null,
  );
});

test("a non-permaweb image has nowhere to fall over to", () => {
  const url = "https://relay.example/media/abc.png";
  assert.equal(nextArweaveGatewayUrl(url, url), null);
});
