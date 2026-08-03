import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import type { ToonOnboardingBalanceState } from "@/features/onboarding/toon/useToonOnboarding";

/**
 * Settings -> Payments (buzz#77): the owner's own wallet and payment channel.
 *
 * Pure state derivation only — network reads and actions live in
 * `usePaymentsOverview.ts` and `ToonPaidWriter`. Mirrors the huddle fee
 * quote's discriminated-union idiom (`huddleFeeQuote.ts`): a `kind` per
 * reality the card can be in, so the component never juggles a pile of
 * independent booleans.
 */

/** Where a tracked payment channel sits in `ToonClient`'s withdraw journey. */
export type ChannelCloseState = "open" | "closing" | "settleable" | "settled";

/** What `ToonPaidWriter.getChannelStatus()` reads off the client, unmodified. */
export type RawPaymentChannelStatus = {
  channelId: string;
  depositTotalBaseUnits: bigint;
  cumulativeAmountBaseUnits: bigint;
  closeState: ChannelCloseState;
  settleableAt: bigint | null;
};

/** The channel half of the Payments card. */
export type PaymentChannelState =
  /** No channel has ever opened for this destination — nothing to show yet. */
  | { kind: "none" }
  | {
      kind: "open";
      remainingBaseUnits: bigint;
      depositTotalBaseUnits: bigint;
    }
  | { kind: "closing"; remainingBaseUnits: bigint; settleableAt: bigint | null }
  | { kind: "settleable"; remainingBaseUnits: bigint }
  | { kind: "settled" };

/**
 * Derive the channel state from a raw on-chain read, or `null` when no
 * channel has ever been opened for this destination. Floors the remaining
 * runway at zero: a stale read where tracked spend has outrun the tracked
 * deposit (the two update independently) must never show a negative balance.
 */
export function deriveChannelState(
  raw: RawPaymentChannelStatus | null,
): PaymentChannelState {
  if (raw === null) return { kind: "none" };

  const remaining = raw.depositTotalBaseUnits - raw.cumulativeAmountBaseUnits;
  const remainingBaseUnits = remaining > 0n ? remaining : 0n;

  switch (raw.closeState) {
    case "open":
      return {
        kind: "open",
        remainingBaseUnits,
        depositTotalBaseUnits: raw.depositTotalBaseUnits,
      };
    case "closing":
      return {
        kind: "closing",
        remainingBaseUnits,
        settleableAt: raw.settleableAt,
      };
    case "settleable":
      return { kind: "settleable", remainingBaseUnits };
    case "settled":
      return { kind: "settled" };
  }
}

/** The runway line shown under the channel row. */
export function channelRunwayCaption(state: PaymentChannelState): string {
  switch (state.kind) {
    case "none":
      return "No payment channel is open yet — it opens automatically on the first paid write.";
    case "open":
      return `${formatUsdcBaseUnits(state.remainingBaseUnits)} of runway left in the open channel.`;
    case "closing":
      return `Channel is closing — ${formatUsdcBaseUnits(state.remainingBaseUnits)} will be reclaimed once it settles.`;
    case "settleable":
      return `Channel is ready to settle — ${formatUsdcBaseUnits(state.remainingBaseUnits)} to reclaim.`;
    case "settled":
      return "Channel is settled — collateral has been reclaimed.";
  }
}

const USDC_DECIMALS = 6;

/**
 * Parse a user-typed decimal USDC amount (the deposit field) into base
 * units, or `null` when the text is not a positive amount with at most 6
 * decimal places. Deliberately strict — a top-up amount is real money, so a
 * malformed or zero input should refuse rather than guess.
 */
export function parseUsdcAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > USDC_DECIMALS) return null;

  const amount =
    BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) +
    BigInt(fraction.padEnd(USDC_DECIMALS, "0") || "0");
  return amount > 0n ? amount : null;
}

/** Top-up only makes sense while the channel is open and taking claims. */
export function canDepositToChannel(state: PaymentChannelState): boolean {
  return state.kind === "open";
}

/** Closing starts the grace period — only meaningful from an open channel. */
export function canCloseChannel(state: PaymentChannelState): boolean {
  return state.kind === "open";
}

/** Settling releases collateral — only once the grace period has elapsed. */
export function canSettleChannel(state: PaymentChannelState): boolean {
  return state.kind === "settleable";
}

/** The whole Payments card's state — what to render before the channel/balance detail. */
export type PaymentsCardState =
  /** Not on the TOON transport — nothing here costs money. */
  | { kind: "relay" }
  /** TOON is active but onboarding never generated/imported a payment identity. */
  | { kind: "no-wallet" }
  /** A wallet identity exists; its first balance/channel reads are in flight. */
  | { kind: "loading" }
  | {
      kind: "ready";
      address: string;
      balances: ToonOnboardingBalanceState;
      channel: PaymentChannelState;
    };

/** Derive the card's top-level state from a snapshot of reality. No I/O. */
export function derivePaymentsCardState(input: {
  isToon: boolean;
  mnemonic: string | null;
  address: string | null;
  balances: ToonOnboardingBalanceState;
  channel: PaymentChannelState | null;
}): PaymentsCardState {
  if (!input.isToon) return { kind: "relay" };
  if (input.mnemonic === null) return { kind: "no-wallet" };
  if (
    input.address === null ||
    !input.balances.checked ||
    input.channel === null
  ) {
    return { kind: "loading" };
  }
  return {
    kind: "ready",
    address: input.address,
    balances: input.balances,
    channel: input.channel,
  };
}
