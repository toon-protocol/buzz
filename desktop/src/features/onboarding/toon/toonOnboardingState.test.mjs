import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveToonOnboardingStatus,
  isChannelStepConfirmed,
  toonOnboardingStepNumber,
} from "./toonOnboardingState.ts";

const BASE = {
  hasWallet: false,
  usdcBaseUnits: null,
  nativeBaseUnits: null,
  channelConfirmed: false,
  firstMessageSent: false,
};

test("no wallet yet lands on the identity step, regardless of everything else", () => {
  const status = deriveToonOnboardingStatus({
    ...BASE,
    channelConfirmed: true,
    firstMessageSent: true,
  });
  assert.equal(status.step, "identity");
});

test("a wallet with an unread balance stays on fund, not funded", () => {
  // null must not read as zero — an unread balance is not an empty wallet.
  const status = deriveToonOnboardingStatus({ ...BASE, hasWallet: true });
  assert.equal(status.step, "fund");
  assert.equal(status.fundedForToken, false);
  assert.equal(status.hasNativeGas, false);
});

test("a wallet with zero of both balances stays on fund", () => {
  const status = deriveToonOnboardingStatus({
    ...BASE,
    hasWallet: true,
    usdcBaseUnits: 0n,
    nativeBaseUnits: 0n,
  });
  assert.equal(status.step, "fund");
});

test("token landed but gas did not — fund step, flagged for manual top-up", () => {
  // The faucet's gas leg is best-effort; this is an expected steady state.
  const status = deriveToonOnboardingStatus({
    ...BASE,
    hasWallet: true,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 0n,
  });
  assert.equal(status.step, "fund");
  assert.equal(status.fundedForToken, true);
  assert.equal(status.hasNativeGas, false);
  assert.equal(status.needsManualGasTopUp, true);
});

test("gas landed but token did not — fund step, no manual-gas flag", () => {
  const status = deriveToonOnboardingStatus({
    ...BASE,
    hasWallet: true,
    usdcBaseUnits: 0n,
    nativeBaseUnits: 1_000_000_000_000_000n,
  });
  assert.equal(status.step, "fund");
  assert.equal(status.needsManualGasTopUp, false);
});

test("funded on both moves to the channel step", () => {
  const status = deriveToonOnboardingStatus({
    ...BASE,
    hasWallet: true,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
  });
  assert.equal(status.step, "channel");
  assert.equal(status.needsManualGasTopUp, false);
});

test("funded and channel-confirmed moves to the message step", () => {
  const status = deriveToonOnboardingStatus({
    ...BASE,
    hasWallet: true,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
    channelConfirmed: true,
  });
  assert.equal(status.step, "message");
});

test("everything true is done — the gate closes", () => {
  const status = deriveToonOnboardingStatus({
    hasWallet: true,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
    channelConfirmed: true,
    firstMessageSent: true,
  });
  assert.equal(status.step, "done");
});

test("re-entrancy: a lost channel-confirmed flag re-quotes the channel step, not funding", () => {
  // A user who quits right after opening the channel but before the wizard
  // could persist the flag (or reinstalls with balances intact but the flag
  // cleared) must land back on "channel", not be sent through funding again —
  // funding is unaffected by the lost flag because it is derived from a live
  // balance, not from this flag at all.
  const status = deriveToonOnboardingStatus({
    ...BASE,
    hasWallet: true,
    usdcBaseUnits: 1_000_000n,
    nativeBaseUnits: 1_000_000_000_000_000n,
    channelConfirmed: false,
  });
  assert.equal(status.step, "channel");
});

test("isChannelStepConfirmed: false unless something makes it true", () => {
  assert.equal(
    isChannelStepConfirmed({
      channelConfirmedFlag: false,
      transportWritable: false,
      resumableChannelExists: false,
    }),
    false,
  );
});

test("isChannelStepConfirmed: the wizard's own persisted flag is enough", () => {
  assert.equal(
    isChannelStepConfirmed({
      channelConfirmedFlag: true,
      transportWritable: false,
      resumableChannelExists: false,
    }),
    true,
  );
});

test("isChannelStepConfirmed: a live writer is enough, even without the flag", () => {
  assert.equal(
    isChannelStepConfirmed({
      channelConfirmedFlag: false,
      transportWritable: true,
      resumableChannelExists: false,
    }),
    true,
  );
});

test("isChannelStepConfirmed (buzz#28): a resumable channel counts as open on its own", () => {
  // The exact scenario the fix targets: a channel persisted from an earlier
  // launch, before this session's writer has started and with no persisted
  // consent flag (e.g. a lost/never-set flag) — resuming spends nothing new,
  // so there is nothing left to consent to.
  assert.equal(
    isChannelStepConfirmed({
      channelConfirmedFlag: false,
      transportWritable: false,
      resumableChannelExists: true,
    }),
    true,
  );
});

test("step numbers are 1-based and stable", () => {
  assert.equal(toonOnboardingStepNumber("identity"), 1);
  assert.equal(toonOnboardingStepNumber("fund"), 2);
  assert.equal(toonOnboardingStepNumber("channel"), 3);
  assert.equal(toonOnboardingStepNumber("message"), 4);
});

test("done clamps to the last step number", () => {
  assert.equal(toonOnboardingStepNumber("done"), 4);
});
