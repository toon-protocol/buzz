import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROVISIONING_STEP_ORDER,
  agentProvisioningStepNumber,
  deriveAgentProvisioningStatus,
} from "./agentProvisioningState.ts";

const BASE = {
  accountIndex: null,
  usdcBaseUnits: null,
  nativeBaseUnits: null,
  channelConfirmed: false,
};

test("no account index yet lands on the key step, regardless of everything else", () => {
  const status = deriveAgentProvisioningStatus({
    ...BASE,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
    channelConfirmed: true,
  });
  assert.equal(status.step, "key");
});

test("an assigned index with an unread balance stays on fund, not funded", () => {
  // null must not read as zero — an unread balance is not an empty wallet.
  const status = deriveAgentProvisioningStatus({ ...BASE, accountIndex: 1 });
  assert.equal(status.step, "fund");
  assert.equal(status.fundedForToken, false);
  assert.equal(status.hasNativeGas, false);
});

test("zero of both balances stays on fund", () => {
  const status = deriveAgentProvisioningStatus({
    ...BASE,
    accountIndex: 1,
    usdcBaseUnits: 0n,
    nativeBaseUnits: 0n,
  });
  assert.equal(status.step, "fund");
});

test("token landed but gas did not — fund step, flagged for manual top-up", () => {
  const status = deriveAgentProvisioningStatus({
    ...BASE,
    accountIndex: 1,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 0n,
  });
  assert.equal(status.step, "fund");
  assert.equal(status.fundedForToken, true);
  assert.equal(status.hasNativeGas, false);
  assert.equal(status.needsManualGasTopUp, true);
});

test("gas landed but token did not — fund step, no manual-gas flag", () => {
  const status = deriveAgentProvisioningStatus({
    ...BASE,
    accountIndex: 1,
    usdcBaseUnits: 0n,
    nativeBaseUnits: 1_000_000_000_000_000n,
  });
  assert.equal(status.step, "fund");
  assert.equal(status.needsManualGasTopUp, false);
});

test("funded on both moves to the channel step", () => {
  const status = deriveAgentProvisioningStatus({
    ...BASE,
    accountIndex: 1,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
  });
  assert.equal(status.step, "channel");
  assert.equal(status.needsManualGasTopUp, false);
});

test("funded and channel-confirmed is done", () => {
  const status = deriveAgentProvisioningStatus({
    ...BASE,
    accountIndex: 1,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
    channelConfirmed: true,
  });
  assert.equal(status.step, "done");
});

test("re-entrancy: a lost channel-confirmed flag re-quotes the channel step, not funding", () => {
  // Funding is derived from a live balance read, never from the flag, so a
  // lost flag (quit right after opening, or a reinstall) cannot strand the
  // agent back on the fund step it already cleared.
  const status = deriveAgentProvisioningStatus({
    ...BASE,
    accountIndex: 1,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
    channelConfirmed: false,
  });
  assert.equal(status.step, "channel");
});

test("step numbers are 1-based and stable", () => {
  assert.equal(agentProvisioningStepNumber("key"), 1);
  assert.equal(agentProvisioningStepNumber("fund"), 2);
  assert.equal(agentProvisioningStepNumber("channel"), 3);
});

test("done clamps to the last step number", () => {
  assert.equal(agentProvisioningStepNumber("done"), 3);
  assert.equal(AGENT_PROVISIONING_STEP_ORDER.length, 3);
});
