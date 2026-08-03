import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";

/**
 * Net-flow domain logic for the Money tab's Network spend block (buzz#86).
 *
 * toon-meta#262 decision 9 puts earning on the SAME channel an agent spends
 * from: `spendable = deposit − owed + credited`, one balance, never a
 * second "earnings" pot. #261 decision 4 modelled money as net flow for
 * exactly this reason — earning lands here without a UI rewrite.
 *
 * This module is deliberately decoupled from any live data source. The
 * connector claim-state read this feeds from (toon-client#494's
 * `getClaimState()`) is not yet vendored in this repo's pinned
 * `@toon-protocol/client` (0.25.1), and the Network spend block itself
 * (#80 — balance/allowance/refill, `onPaidWrite` live spend) has not
 * landed, so there is no per-agent channel read to attach a UI to yet.
 * These are the pure derivations #80 and the AgentIdentityCard earning
 * badge / low-funds alert can wire straight into once that read exists —
 * mirrors `paymentsOverview.ts`'s pure-derivation-first idiom.
 *
 * Per the Gotchas, income here is never read from a self-reported
 * money-report event — only from `NetworkFlowRead`, the shape a connector
 * claim-state read produces.
 */

/**
 * A single lucky job must not flip runway to "indefinite" — that is a lie
 * that strands someone once the job stream dries up. Require sustained
 * income over several samples before treating an agent as self-funding.
 */
const MIN_INCOME_SAMPLES_TO_TRUST = 3;

/** What a connector claim-state read reports for one agent's channel. */
export type NetworkFlowRead = {
  depositBaseUnits: bigint;
  /** Claimed/spent against the deposit so far. */
  owedBaseUnits: bigint;
  /** Earned into this same channel — never a separate balance. */
  creditedBaseUnits: bigint;
  /** Trailing-window spend rate. */
  burnRateBaseUnitsPerSec: number;
  /** Trailing-window income rate. */
  incomeRateBaseUnitsPerSec: number;
  /** Distinct income events observed in the trailing window. */
  incomeSampleCount: number;
};

/**
 * `spendable = deposit − owed + credited`, floored at zero — a stale or
 * racy read must never show a negative balance.
 */
export function netSpendableBaseUnits(read: NetworkFlowRead): bigint {
  const net =
    read.depositBaseUnits - read.owedBaseUnits + read.creditedBaseUnits;
  return net > 0n ? net : 0n;
}

/** Whether `read`'s income has enough evidence behind it to be trusted. */
function hasTrustedIncome(read: NetworkFlowRead): boolean {
  return read.incomeSampleCount >= MIN_INCOME_SAMPLES_TO_TRUST;
}

/** The runway half of the Network spend block. */
export type NetworkRunwayState =
  | { kind: "depleted" }
  /** Trusted income covers or exceeds burn — no depletion date to show. */
  | { kind: "self-funding"; remainingBaseUnits: bigint }
  | { kind: "finite"; remainingBaseUnits: bigint; runwaySeconds: number };

/**
 * Derive runway from a net-flow read. Untrusted income (too few samples)
 * is excluded from the burn-rate offset entirely, so an agent's runway
 * degrades to "burn rate alone" — the honest, conservative default —
 * until income has proven itself sustained.
 */
export function deriveNetworkRunway(read: NetworkFlowRead): NetworkRunwayState {
  const remainingBaseUnits = netSpendableBaseUnits(read);
  if (remainingBaseUnits <= 0n) return { kind: "depleted" };

  const trustedIncomeRate = hasTrustedIncome(read)
    ? read.incomeRateBaseUnitsPerSec
    : 0;
  const netBurnRateBaseUnitsPerSec =
    read.burnRateBaseUnitsPerSec - trustedIncomeRate;

  if (netBurnRateBaseUnitsPerSec <= 0) {
    return { kind: "self-funding", remainingBaseUnits };
  }

  const runwaySeconds = Number(remainingBaseUnits) / netBurnRateBaseUnitsPerSec;
  return { kind: "finite", remainingBaseUnits, runwaySeconds };
}

function formatRunwayDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} hr`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** The caption the Network spend block shows under the runway row. */
export function networkRunwayCaption(state: NetworkRunwayState): string {
  switch (state.kind) {
    case "depleted":
      return "Balance is depleted — writes will fail until it is topped up.";
    case "self-funding":
      return `${formatUsdcBaseUnits(state.remainingBaseUnits)} available — income is covering spend, so there's no depletion date.`;
    case "finite":
      return `${formatUsdcBaseUnits(state.remainingBaseUnits)} available — about ${formatRunwayDuration(state.runwaySeconds)} of runway left.`;
  }
}

/**
 * Whether an agent pays for itself — the `AgentIdentityCard` earning badge
 * predicate. Requires the same trusted-income bar as runway, so the fleet
 * glance never claims self-funding off one job.
 */
export function isEarning(read: NetworkFlowRead): boolean {
  return (
    hasTrustedIncome(read) &&
    read.incomeRateBaseUnitsPerSec >= read.burnRateBaseUnitsPerSec
  );
}

/**
 * A rescue prompt for a self-funding agent is noise that teaches people to
 * ignore the alert — suppress it only once `deriveNetworkRunway` has
 * actually concluded the agent is self-funding.
 */
export function shouldSuppressLowFundsAlert(read: NetworkFlowRead): boolean {
  return deriveNetworkRunway(read).kind === "self-funding";
}
