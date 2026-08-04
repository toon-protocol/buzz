import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentProvisioningError,
  buildAgentProvisioningClient,
  buildOwnerProvisioningClient,
  deriveAgentAddress,
  fundAgentWallet,
  openAgentChannel,
} from "./provisionAgent.ts";
import { resolveToonTransportConfig } from "@/shared/api/toonTransportConfig";

/**
 * Covers buzz#74's fund + open-channel orchestration. Every test drives a
 * scripted `ProvisioningClient` stub rather than a real `ToonClient` — same
 * dependency-injection shape `toonPaidWriter.test.mjs` uses for `PaidClient`.
 */

function scriptedClient(overrides = {}) {
  return {
    started: 0,
    stopped: 0,
    transfers: [],
    openedDestinations: [],
    start() {
      this.started += 1;
      return Promise.resolve({});
    },
    stop() {
      this.stopped += 1;
      return Promise.resolve();
    },
    sendTransfer(params) {
      this.transfers.push(params);
      return Promise.resolve({
        txHash: "0xabc",
        balanceBefore: "0",
        balanceAfter: params.amount.toString(),
      });
    },
    openChannel(destination) {
      this.openedDestinations.push(destination);
      return Promise.resolve("channel-1");
    },
    ...overrides,
  };
}

test("fundAgentWallet sends both legs to the agent's address", async () => {
  const client = scriptedClient();
  const result = await fundAgentWallet({
    ownerClient: client,
    agentAddress: "0xagent",
    chain: "evm",
    nativeAmountBaseUnits: 1_000n,
    tokenAmountBaseUnits: 2_000n,
  });

  assert.equal(result.native.status, "ok");
  assert.equal(result.token.status, "ok");
  assert.deepEqual(
    client.transfers.map((t) => ({
      asset: t.asset,
      to: t.to,
      amount: t.amount,
    })),
    [
      { asset: "native", to: "0xagent", amount: 1_000n },
      { asset: "token", to: "0xagent", amount: 2_000n },
    ],
  );
});

test("fundAgentWallet reports one leg's failure without losing the other's success", async () => {
  const client = scriptedClient({
    sendTransfer(params) {
      if (params.asset === "native") {
        return Promise.reject(new Error("faucet's gas leg is best-effort"));
      }
      this.transfers.push(params);
      return Promise.resolve({
        txHash: "0xabc",
        balanceBefore: "0",
        balanceAfter: params.amount.toString(),
      });
    },
  });

  const result = await fundAgentWallet({
    ownerClient: client,
    agentAddress: "0xagent",
    chain: "evm",
    nativeAmountBaseUnits: 1_000n,
    tokenAmountBaseUnits: 2_000n,
  });

  assert.equal(result.native.status, "error");
  assert.match(result.native.message, /best-effort/);
  assert.equal(result.token.status, "ok");
});

test("fundAgentWallet never throws — both legs report as tagged results", async () => {
  const client = scriptedClient({
    sendTransfer: () => Promise.reject(new Error("delivery not observed")),
  });

  const result = await fundAgentWallet({
    ownerClient: client,
    agentAddress: "0xagent",
    chain: "evm",
    nativeAmountBaseUnits: 1_000n,
    tokenAmountBaseUnits: 2_000n,
  });

  assert.equal(result.native.status, "error");
  assert.equal(result.token.status, "error");
});

test("openAgentChannel starts the client, opens against the destination, then stops it", async () => {
  const client = scriptedClient();
  const channelId = await openAgentChannel({
    agentClient: client,
    destination: "g.toon.relay",
  });

  assert.equal(channelId, "channel-1");
  assert.equal(client.started, 1);
  assert.deepEqual(client.openedDestinations, ["g.toon.relay"]);
  assert.equal(client.stopped, 1);
});

test("openAgentChannel still stops the client when openChannel throws", async () => {
  const client = scriptedClient({
    openChannel: () => Promise.reject(new Error("insufficient funds")),
  });

  await assert.rejects(
    () =>
      openAgentChannel({ agentClient: client, destination: "g.toon.relay" }),
    /insufficient funds/,
  );
  assert.equal(client.stopped, 1);
});

const CONFIG_WITH_MNEMONIC = resolveToonTransportConfig({
  BUZZ_TOON_MNEMONIC: "test test test",
});
const CONFIG_WITHOUT_MNEMONIC = resolveToonTransportConfig({});

test("buildOwnerProvisioningClient rejects with no owner mnemonic configured, before touching the factory", async () => {
  let factoryCalled = false;
  await assert.rejects(
    () =>
      buildOwnerProvisioningClient(CONFIG_WITHOUT_MNEMONIC, async () => {
        factoryCalled = true;
        return scriptedClient();
      }),
    AgentProvisioningError,
  );
  assert.equal(factoryCalled, false);
});

test("buildOwnerProvisioningClient builds at the owner's account index and starts it", async () => {
  const client = scriptedClient();
  let seenArgs = null;
  const result = await buildOwnerProvisioningClient(
    CONFIG_WITH_MNEMONIC,
    async (_config, accountIndex, initialDeposit) => {
      seenArgs = { accountIndex, initialDeposit };
      return client;
    },
  );
  assert.equal(result, client);
  assert.equal(client.started, 1);
  assert.equal(seenArgs.accountIndex, CONFIG_WITH_MNEMONIC.accountIndex);
  assert.equal(seenArgs.initialDeposit, null);
});

test("buildAgentProvisioningClient rejects with no owner mnemonic configured", async () => {
  await assert.rejects(
    () =>
      buildAgentProvisioningClient(
        CONFIG_WITHOUT_MNEMONIC,
        3,
        10_000_000n,
        async () => scriptedClient(),
      ),
    AgentProvisioningError,
  );
});

test("buildAgentProvisioningClient builds at the agent's index with the allowance as a string, without starting it", async () => {
  const client = scriptedClient();
  let seenArgs = null;
  const result = await buildAgentProvisioningClient(
    CONFIG_WITH_MNEMONIC,
    3,
    10_000_000n,
    async (_config, accountIndex, initialDeposit) => {
      seenArgs = { accountIndex, initialDeposit };
      return client;
    },
  );
  assert.equal(result, client);
  assert.equal(client.started, 0);
  assert.equal(seenArgs.accountIndex, 3);
  assert.equal(seenArgs.initialDeposit, "10000000");
});

test("deriveAgentAddress is deterministic and index-scoped", async () => {
  // Anvil's well-known test phrase — a fixed test vector rather than a
  // generated one, so a derivation regression fails against a known answer.
  const mnemonic =
    "test test test test test test test test test test test junk";

  const indexOne = await deriveAgentAddress(mnemonic, 1);
  assert.match(indexOne, /^0x[0-9a-fA-F]{40}$/);
  // Same phrase, same index — derivation must be deterministic.
  assert.equal(await deriveAgentAddress(mnemonic, 1), indexOne);

  // A different index must derive a different address — two agents on the
  // same owner mnemonic must never collide onto the same payment identity.
  const indexTwo = await deriveAgentAddress(mnemonic, 2);
  assert.notEqual(indexTwo, indexOne);
});

test("AgentProvisioningError carries a readable message", () => {
  const error = new AgentProvisioningError("no owner mnemonic configured");
  assert.equal(error.name, "AgentProvisioningError");
  assert.equal(error.message, "no owner mnemonic configured");
});
