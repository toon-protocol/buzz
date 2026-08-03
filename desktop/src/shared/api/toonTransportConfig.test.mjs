import assert from "node:assert/strict";
import test from "node:test";

import {
  decideTransport,
  describeWriteBlocker,
  parseTransportMode,
  resolveToonTransportConfig,
  TOON_DEVNET_DEFAULTS,
} from "./toonTransportConfig.ts";

test("an unset or blank transport falls back to the relay", () => {
  assert.deepEqual(parseTransportMode(undefined), {
    mode: "relay",
    unrecognised: null,
  });
  assert.deepEqual(parseTransportMode("   "), {
    mode: "relay",
    unrecognised: null,
  });
});

test("the transport name is case-insensitive and trimmed", () => {
  assert.equal(parseTransportMode(" TOON ").mode, "toon");
  assert.equal(parseTransportMode("Relay").mode, "relay");
});

test("an unknown transport name lands on the relay and says so", () => {
  // Upstream parity: a typo must degrade to the transport `block/buzz` also
  // runs, not to a broken app.
  const parsed = parseTransportMode("tooon");

  assert.equal(parsed.mode, "relay");
  assert.equal(parsed.unrecognised, "tooon");
});

test("an empty environment resolves to the devnet defaults", () => {
  const config = resolveToonTransportConfig({});

  assert.equal(config.mode, "relay");
  assert.equal(config.proxyUrl, TOON_DEVNET_DEFAULTS.proxyUrl);
  assert.equal(config.relayUrl, TOON_DEVNET_DEFAULTS.relayUrl);
  assert.equal(config.destination, TOON_DEVNET_DEFAULTS.destination);
  assert.equal(config.chain, TOON_DEVNET_DEFAULTS.chain);
  assert.equal(config.mnemonic, null);
  assert.equal(config.accountIndex, 0);
  assert.equal(config.faucetUrl, TOON_DEVNET_DEFAULTS.faucetUrl);
});

test("every endpoint is overridable", () => {
  const config = resolveToonTransportConfig({
    BUZZ_TOON_PROXY_URL: "https://edge.example/ilp",
    BUZZ_TOON_RELAY_URL: "wss://relay.example",
    BUZZ_TOON_DESTINATION: "g.example.relay",
    BUZZ_TOON_CHAIN: "evm:31337",
    BUZZ_TOON_CHAIN_RPC_URL: "http://localhost:8545",
    BUZZ_TOON_TOKEN_NETWORK: "0xtn",
    BUZZ_TOON_PREFERRED_TOKEN: "0xusdc",
    BUZZ_TOON_FAUCET_URL: "https://faucet.example",
  });

  assert.equal(config.proxyUrl, "https://edge.example/ilp");
  assert.equal(config.relayUrl, "wss://relay.example");
  assert.equal(config.destination, "g.example.relay");
  assert.equal(config.chain, "evm:31337");
  assert.equal(config.chainRpcUrl, "http://localhost:8545");
  assert.equal(config.tokenNetwork, "0xtn");
  assert.equal(config.preferredToken, "0xusdc");
  assert.equal(config.faucetUrl, "https://faucet.example");
});

test("a blank override does not shadow the default", () => {
  const config = resolveToonTransportConfig({ BUZZ_TOON_RELAY_URL: "  " });

  assert.equal(config.relayUrl, TOON_DEVNET_DEFAULTS.relayUrl);
});

test("a non-numeric account index degrades to 0", () => {
  assert.equal(
    resolveToonTransportConfig({ BUZZ_TOON_ACCOUNT_INDEX: "3" }).accountIndex,
    3,
  );
  assert.equal(
    resolveToonTransportConfig({ BUZZ_TOON_ACCOUNT_INDEX: "-1" }).accountIndex,
    0,
  );
  assert.equal(
    resolveToonTransportConfig({ BUZZ_TOON_ACCOUNT_INDEX: "x" }).accountIndex,
    0,
  );
});

test("BTP is the default paid-write wire", () => {
  const config = resolveToonTransportConfig({});

  assert.equal(config.connectorUrl, TOON_DEVNET_DEFAULTS.connectorUrl);
  assert.equal(config.btpUrl, TOON_DEVNET_DEFAULTS.btpUrl);
});

test("the BTP endpoints are overridable", () => {
  const config = resolveToonTransportConfig({
    BUZZ_TOON_CONNECTOR_URL: "https://edge.example",
    BUZZ_TOON_BTP_URL: "wss://edge.example/ilp/btp",
  });

  assert.equal(config.connectorUrl, "https://edge.example");
  assert.equal(config.btpUrl, "wss://edge.example/ilp/btp");
});

test("BUZZ_TOON_BTP_URL=off opts out of BTP entirely", () => {
  // `off` (any case) means "this edge does not speak BTP" — paid writes fall
  // back to one-shot ILP-over-HTTP, they do not dial a default BTP socket.
  assert.equal(
    resolveToonTransportConfig({ BUZZ_TOON_BTP_URL: "off" }).btpUrl,
    null,
  );
  assert.equal(
    resolveToonTransportConfig({ BUZZ_TOON_BTP_URL: "OFF" }).btpUrl,
    null,
  );
});

test("a blank BTP url means the default, not opting out", () => {
  assert.equal(
    resolveToonTransportConfig({ BUZZ_TOON_BTP_URL: "  " }).btpUrl,
    TOON_DEVNET_DEFAULTS.btpUrl,
  );
});

test("a missing payment key blocks writes but not reads", () => {
  const config = resolveToonTransportConfig({});

  assert.match(describeWriteBlocker(config), /BUZZ_TOON_MNEMONIC/);
  assert.equal(
    describeWriteBlocker({ ...config, mnemonic: "abandon ability" }),
    null,
  );
});

test("decideTransport keeps the relay unless TOON is asked for", () => {
  assert.equal(decideTransport({}).mode, "relay");
  assert.equal(decideTransport({ BUZZ_TRANSPORT: "relay" }).mode, "relay");
  assert.equal(decideTransport({ BUZZ_TRANSPORT: "toon" }).mode, "toon");
});

test("the dev override outranks the runtime environment", () => {
  const selection = decideTransport({ BUZZ_TRANSPORT: "relay" }, "toon");

  assert.equal(selection.mode, "toon");
  assert.equal(selection.config.mode, "toon");
});

test("decideTransport warns about an unusable TOON config", () => {
  const selection = decideTransport({ BUZZ_TRANSPORT: "toon" });

  assert.equal(selection.mode, "toon");
  assert.equal(selection.warnings.length, 1);
  assert.match(selection.warnings[0], /BUZZ_TOON_MNEMONIC/);
});

test("decideTransport stays quiet about a missing key on the relay", () => {
  // The TOON payment key is irrelevant when TOON is not the transport.
  assert.deepEqual(decideTransport({}).warnings, []);
});

test("decideTransport reports an unknown transport name", () => {
  const selection = decideTransport({ BUZZ_TRANSPORT: "quic" });

  assert.equal(selection.mode, "relay");
  assert.match(selection.warnings[0], /quic/);
});

test("the store route defaults to the store box and is independently overridable", () => {
  // The store node is a sibling of the relay on the devnet, not a child route,
  // so it cannot be derived from `destination` — see ADR 0002.
  assert.equal(
    resolveToonTransportConfig({}).storeDestination,
    TOON_DEVNET_DEFAULTS.storeDestination,
  );
  assert.equal(
    resolveToonTransportConfig({
      BUZZ_TOON_DESTINATION: "g.other.relay",
    }).storeDestination,
    TOON_DEVNET_DEFAULTS.storeDestination,
    "moving the publish route must not silently move media with it",
  );
  assert.equal(
    resolveToonTransportConfig({
      BUZZ_TOON_STORE_DESTINATION: " g.test.store ",
    }).storeDestination,
    "g.test.store",
  );
});

test("the Arweave gateway list is comma-separated, trimmed, and empty when unset", () => {
  assert.deepEqual(resolveToonTransportConfig({}).arweaveGateways, []);
  assert.deepEqual(
    resolveToonTransportConfig({
      BUZZ_TOON_ARWEAVE_GATEWAYS: " https://a.example , ,https://b.example ",
    }).arweaveGateways,
    ["https://a.example", "https://b.example"],
  );
});

test("the initial channel deposit defaults to an audio-viable ceiling", () => {
  // The client library's own 0.1 USDC default buys ~2 seconds of huddle
  // frames at the devnet fee; buzz defaults higher and lets operators tune.
  assert.equal(
    resolveToonTransportConfig({}).initialDeposit,
    TOON_DEVNET_DEFAULTS.initialDeposit,
  );
  assert.equal(
    resolveToonTransportConfig({ BUZZ_TOON_INITIAL_DEPOSIT: "250000" })
      .initialDeposit,
    "250000",
  );
});

test("a malformed deposit degrades to the default rather than to the client's", () => {
  for (const bad of ["ten", "-5", "1.5", "  "]) {
    assert.equal(
      resolveToonTransportConfig({ BUZZ_TOON_INITIAL_DEPOSIT: bad })
        .initialDeposit,
      TOON_DEVNET_DEFAULTS.initialDeposit,
      `value ${JSON.stringify(bad)} must fall back to the default`,
    );
  }
});
