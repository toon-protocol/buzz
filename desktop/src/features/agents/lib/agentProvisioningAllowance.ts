import { DEFAULT_CHANNEL_COLLATERAL_BASE_UNITS } from "@/features/onboarding/toon/toonOnboardingFormat";

/**
 * Initial payment-channel allowance for a freshly-provisioned agent (buzz#74,
 * toon-meta#262 decision 8): sized from the agent's own measured burn rate
 * so the default survives an operator price change, rather than a fixed
 * USDC number.
 *
 * A brand-new agent has no burn history by construction — provisioning at
 * creation always takes the days-of-runway fallback below. The burn-rate
 * branch is here for a later re-provisioning/top-up caller once an agent has
 * spend history: it reuses `agentNetworkFlow.ts`'s `NetworkFlowRead.burnRateBaseUnitsPerSec`
 * shape (passed as a plain number rather than the whole read, since this
 * function needs nothing else from it) so both callers agree on what "burn
 * rate" means. That per-agent live read does not exist yet — same documented
 * blocker `agentNetworkFlow.ts` already carries (toon-client#494's
 * `getClaimState()`, and the Network spend block, #80) — so today every
 * caller passes `null` here and takes the fallback.
 */

/** Conservative runway target when there is no spend history to measure. */
export const FALLBACK_RUNWAY_DAYS = 7;

/**
 * A first-cut estimate of write volume for an agent with no history yet —
 * deliberately generous (epic decision 8's "generous default") rather than
 * bare-minimum, so a freshly provisioned agent is not starved on day one.
 * Revisit once real per-agent write-rate data exists to calibrate against.
 */
export const FALLBACK_WRITES_PER_DAY = 2_000;

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Native gas to send an agent on provisioning — not sized from burn rate
 * (gas pays for the one channel-open transaction, not per-write spend).
 * 0.002 ETH on Base Sepolia: comfortably covers a channel-open with room for
 * gas-price movement, without being large enough to matter if it sits idle.
 * A first-cut estimate — revisit if devnet gas prices move materially.
 */
export const DEFAULT_AGENT_NATIVE_GAS_BASE_UNITS = 2_000_000_000_000_000n;

/**
 * The channel-open collateral to request for a freshly provisioned agent.
 *
 * Prefers `measuredBurnRateBaseUnitsPerSec` (a positive measured rate) when
 * available; otherwise falls back to `quotedWritePriceBaseUnits ×
 * FALLBACK_WRITES_PER_DAY × runwayDays`; and if neither input is known at
 * all, falls back to the flat devnet channel-open default the onboarding
 * wizard already shows, so this never returns an amount too small to open a
 * channel with.
 */
export function deriveInitialAllowanceBaseUnits(params: {
  /** The agent's own measured burn rate, or null/zero with no trusted history yet. */
  measuredBurnRateBaseUnitsPerSec: number | null;
  /** The connector's quoted per-write price, or null if unquoted. Only consulted with no burn-rate history. */
  quotedWritePriceBaseUnits: bigint | null;
  /** How many days of runway the allowance should cover. */
  runwayDays?: number;
}): bigint {
  const runwayDays = params.runwayDays ?? FALLBACK_RUNWAY_DAYS;

  if (
    params.measuredBurnRateBaseUnitsPerSec !== null &&
    params.measuredBurnRateBaseUnitsPerSec > 0
  ) {
    // Round up — an allowance that undershoots the measured rate by a
    // fraction of a base unit is worse than one that overshoots by one.
    return BigInt(
      Math.ceil(
        params.measuredBurnRateBaseUnitsPerSec * SECONDS_PER_DAY * runwayDays,
      ),
    );
  }

  if (
    params.quotedWritePriceBaseUnits !== null &&
    params.quotedWritePriceBaseUnits > 0n
  ) {
    return (
      params.quotedWritePriceBaseUnits *
      BigInt(FALLBACK_WRITES_PER_DAY) *
      BigInt(runwayDays)
    );
  }

  return DEFAULT_CHANNEL_COLLATERAL_BASE_UNITS;
}
