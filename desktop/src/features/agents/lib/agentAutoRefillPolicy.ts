import { deriveNetworkRunway } from "@/features/profile/lib/agentNetworkFlow";
import {
  canRefillNetworkSpend,
  type NetworkSpendState,
} from "@/features/profile/lib/networkSpendState";
import {
  deriveInitialAllowanceBaseUnits,
  FALLBACK_RUNWAY_DAYS,
} from "@/features/agents/lib/agentProvisioningAllowance";
import { AGENT_FLEET_RUNWAY_WARNING_DAYS } from "@/features/agents/lib/agentFleetRunway";

/**
 * Opt-in auto-refill with a hard monthly ceiling (buzz#132, epic toon-meta#261
 * decision 8's third and final layer — the generous default allowance and the
 * always-on early warning already shipped, per `agentProvisioningAllowance.ts`
 * and `agentFleetRunway.ts`).
 *
 * Pure decision core, mirroring `autoRestartPolicy.ts`'s shape: every
 * never-fire gate is enumerated and load-bearing (auto-restart's fire kills a
 * mid-turn agent; this fire spends real money), with an exhaustive matrix
 * test alongside it.
 *
 * Deposits only ever land on the identity `getActiveToonTransport()`'s own
 * writer pays as (see `useNetworkSpend.ts`'s module doc) — so in practice
 * only the desktop process's own ("self") identity can ever reach "fire".
 * The config/ledger in `agentAutoRefillStore.ts` is still keyed per agent
 * pubkey (AC1's "opt-in per agent"), which stays correct if a future caller
 * gains the ability to deposit into another agent's channel.
 */

const SECONDS_PER_DAY = 86_400;

export type RefillDecision = "fire" | "arm" | "hold";

export type RefillInputs = {
  /** Per-agent opt-in toggle. Off by default (AC1). */
  optedIn: boolean;
  /** The Network spend block's current read for this agent. */
  state: NetworkSpendState;
  /** Ceiling remaining this month, per `agentAutoRefillStore.ts`'s ledger. */
  remainingCeilingBaseUnits: bigint;
  /** Whether a refill deposit for this agent is already in flight. */
  refillInFlight: boolean;
};

export function decideRefill(inputs: RefillInputs): RefillDecision {
  const { optedIn, state, remainingCeilingBaseUnits, refillInFlight } = inputs;

  // Never-fire gates. Each is load-bearing — see the matrix test.
  if (!optedIn) return "hold";
  // `canRefillNetworkSpend` is the "can I act on this state" answer
  // networkSpendState.ts asks call sites to use; the explicit `kind` check
  // alongside it is what narrows `state.read` for the branches below.
  if (state.kind !== "quoted" || !canRefillNetworkSpend(state)) return "hold";
  // An absent burn sample is a guess dressed as a reading (networkSpendState.ts's
  // own words) — never trigger a spend off a guess.
  if (!state.hasBurnSample) return "hold";
  if (remainingCeilingBaseUnits <= 0n) return "hold";
  // One attempt at a time: a deposit is not instant, and the read keeps
  // showing low runway until it confirms. Without this gate, one low-runway
  // condition fires N deposits.
  if (refillInFlight) return "hold";

  const runway = deriveNetworkRunway(state.read);
  // A self-funding agent needs no top-up.
  if (runway.kind === "self-funding") return "hold";
  if (runway.kind === "depleted") return "fire";

  const runwayDays = runway.runwaySeconds / SECONDS_PER_DAY;
  // Same threshold as the always-on early warning (epic decision 8): refill
  // resolves the warning rather than firing later than it, which would train
  // the user to ignore the alarm.
  return runwayDays < AGENT_FLEET_RUNWAY_WARNING_DAYS ? "fire" : "arm";
}

/**
 * How much to deposit on a "fire" decision: the same burn-rate-derived
 * allowance provisioning uses (so refill and provisioning agree on "how much
 * is enough," and both survive an operator price change), clamped to the
 * ceiling remaining this month. A partial refill beats none — it buys runway
 * for manual rescue even when the full derived amount would breach the
 * ceiling.
 */
export function deriveRefillAmountBaseUnits(params: {
  burnRateBaseUnitsPerSec: number;
  remainingCeilingBaseUnits: bigint;
}): bigint {
  const { burnRateBaseUnitsPerSec, remainingCeilingBaseUnits } = params;
  const derived = deriveInitialAllowanceBaseUnits({
    measuredBurnRateBaseUnitsPerSec: burnRateBaseUnitsPerSec,
    quotedWritePriceBaseUnits: null,
  });
  return derived < remainingCeilingBaseUnits
    ? derived
    : remainingCeilingBaseUnits;
}

/**
 * Runway days a freshly-enabled ceiling should suggest — roughly a month at
 * the fallback rate (4x the provisioning allowance's own runway target), per
 * the owner's "pre-filled suggestion, explicit confirmation" decision.
 */
export const SUGGESTED_CEILING_RUNWAY_DAYS = FALLBACK_RUNWAY_DAYS * 4;

/** The ceiling value pre-filled when the operator opts in, before their edit/confirm. */
export function deriveSuggestedCeilingBaseUnits(params: {
  measuredBurnRateBaseUnitsPerSec: number | null;
  quotedWritePriceBaseUnits: bigint | null;
}): bigint {
  return deriveInitialAllowanceBaseUnits({
    ...params,
    runwayDays: SUGGESTED_CEILING_RUNWAY_DAYS,
  });
}
