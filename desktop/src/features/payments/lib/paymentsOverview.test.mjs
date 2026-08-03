import assert from "node:assert/strict";
import test from "node:test";

import {
  canCloseChannel,
  canDepositToChannel,
  canSettleChannel,
  channelRunwayCaption,
  deriveChannelState,
  derivePaymentsCardState,
  parseUsdcAmount,
} from "./paymentsOverview.ts";

/**
 * Covers buzz#77: the Settings -> Payments card's owner-wallet + channel
 * state derivation. Pure-function tests in the `useComposerFeeQuote` /
 * `huddleFeeQuote` mold — no DOM, no network, just the reality snapshot a
 * caller already read.
 */

const CHECKED_BALANCES = {
  tokenBaseUnits: 5_000_000n,
  nativeBaseUnits: 1_000_000_000_000_000n,
  checked: true,
  unreadable: false,
};

test("no payment channel yet reads as none, not an error", () => {
  const state = deriveChannelState(null);
  assert.deepEqual(state, { kind: "none" });
  assert.match(channelRunwayCaption(state), /opens automatically/);
  assert.equal(canDepositToChannel(state), false);
  assert.equal(canCloseChannel(state), false);
  assert.equal(canSettleChannel(state), false);
});

test("an open channel reports its remaining runway", () => {
  const state = deriveChannelState({
    channelId: "chan-1",
    depositTotalBaseUnits: 10_000_000n,
    cumulativeAmountBaseUnits: 4_000_000n,
    closeState: "open",
    settleableAt: null,
  });
  assert.deepEqual(state, {
    kind: "open",
    remainingBaseUnits: 6_000_000n,
    depositTotalBaseUnits: 10_000_000n,
  });
  assert.match(channelRunwayCaption(state), /6\.00 USDC/);
  assert.equal(canDepositToChannel(state), true);
  assert.equal(canCloseChannel(state), true);
  assert.equal(canSettleChannel(state), false);
});

test("spend cannot outrun deposit — remaining floors at zero", () => {
  // A stale/racy read (spend claimed but the tracked deposit hasn't caught
  // up yet) must never show a negative runway.
  const state = deriveChannelState({
    channelId: "chan-1",
    depositTotalBaseUnits: 1_000_000n,
    cumulativeAmountBaseUnits: 1_500_000n,
    closeState: "open",
    settleableAt: null,
  });
  assert.equal(state.remainingBaseUnits, 0n);
});

test("a closing channel is not depositable or settleable yet", () => {
  const state = deriveChannelState({
    channelId: "chan-1",
    depositTotalBaseUnits: 10_000_000n,
    cumulativeAmountBaseUnits: 4_000_000n,
    closeState: "closing",
    settleableAt: 1_800_000_000n,
  });
  assert.deepEqual(state, {
    kind: "closing",
    remainingBaseUnits: 6_000_000n,
    settleableAt: 1_800_000_000n,
  });
  assert.match(channelRunwayCaption(state), /closing/);
  assert.equal(canDepositToChannel(state), false);
  assert.equal(canCloseChannel(state), false);
  assert.equal(canSettleChannel(state), false);
});

test("a settleable channel can only be settled", () => {
  const state = deriveChannelState({
    channelId: "chan-1",
    depositTotalBaseUnits: 10_000_000n,
    cumulativeAmountBaseUnits: 4_000_000n,
    closeState: "settleable",
    settleableAt: 1_800_000_000n,
  });
  assert.deepEqual(state, {
    kind: "settleable",
    remainingBaseUnits: 6_000_000n,
  });
  assert.match(channelRunwayCaption(state), /ready to settle/);
  assert.equal(canDepositToChannel(state), false);
  assert.equal(canCloseChannel(state), false);
  assert.equal(canSettleChannel(state), true);
});

test("a settled channel offers no further action", () => {
  const state = deriveChannelState({
    channelId: "chan-1",
    depositTotalBaseUnits: 10_000_000n,
    cumulativeAmountBaseUnits: 10_000_000n,
    closeState: "settled",
    settleableAt: 1_800_000_000n,
  });
  assert.deepEqual(state, { kind: "settled" });
  assert.match(channelRunwayCaption(state), /reclaimed/);
  assert.equal(canDepositToChannel(state), false);
  assert.equal(canCloseChannel(state), false);
  assert.equal(canSettleChannel(state), false);
});

test("relay transport has no payments card to show", () => {
  const state = derivePaymentsCardState({
    isToon: false,
    mnemonic: null,
    address: null,
    balances: CHECKED_BALANCES,
    channel: null,
  });
  assert.deepEqual(state, { kind: "relay" });
});

test("TOON active but onboarding never ran — no wallet identity yet", () => {
  const state = derivePaymentsCardState({
    isToon: true,
    mnemonic: null,
    address: null,
    balances: { ...CHECKED_BALANCES, checked: false },
    channel: null,
  });
  assert.deepEqual(state, { kind: "no-wallet" });
});

test("a wallet exists but the first reads have not landed yet", () => {
  const state = derivePaymentsCardState({
    isToon: true,
    mnemonic: "test mnemonic",
    address: null,
    balances: { ...CHECKED_BALANCES, checked: false },
    channel: null,
  });
  assert.deepEqual(state, { kind: "loading" });
});

test("parseUsdcAmount: whole numbers convert to base units", () => {
  assert.equal(parseUsdcAmount("10"), 10_000_000n);
});

test("parseUsdcAmount: fractional amounts convert exactly", () => {
  assert.equal(parseUsdcAmount("0.5"), 500_000n);
  assert.equal(parseUsdcAmount("1.234567"), 1_234_567n);
});

test("parseUsdcAmount: more than 6 decimal places is rejected", () => {
  assert.equal(parseUsdcAmount("1.2345678"), null);
});

test("parseUsdcAmount: zero is not a valid deposit", () => {
  assert.equal(parseUsdcAmount("0"), null);
  assert.equal(parseUsdcAmount("0.000000"), null);
});

test("parseUsdcAmount: garbage and negative input is rejected", () => {
  assert.equal(parseUsdcAmount(""), null);
  assert.equal(parseUsdcAmount("abc"), null);
  assert.equal(parseUsdcAmount("-1"), null);
  assert.equal(parseUsdcAmount("1.2.3"), null);
});

test("a fully-read wallet is ready, channel state included even when none exists", () => {
  const state = derivePaymentsCardState({
    isToon: true,
    mnemonic: "test mnemonic",
    address: "0xabc",
    balances: CHECKED_BALANCES,
    channel: { kind: "none" },
  });
  assert.deepEqual(state, {
    kind: "ready",
    address: "0xabc",
    balances: CHECKED_BALANCES,
    channel: { kind: "none" },
  });
});
