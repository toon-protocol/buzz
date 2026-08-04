import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import {
  deriveNetworkRunway,
  netSpendableBaseUnits,
  networkRunwayCaption,
  type NetworkFlowRead,
} from "@/features/profile/lib/agentNetworkFlow";
import type { LiveSpendSnapshot } from "@/features/profile/lib/networkSpendLiveStore";
import type { RawNetworkFlowStatus } from "@/shared/api/toonPaidWriter";

/**
 * Budget state for the Money tab's Network spend block (#80).
 *
 * Mirrors the huddle fee quote's discriminated union
 * (`relay | pending | unavailable | quoted`) rather than a pile of nullable
 * numbers — the same shape `paymentsOverview.ts`'s `PaymentsCardState`
 * already uses for the sibling Settings -> Payments card. "Can the refill
 * action run" is answered separately by {@link canRefillNetworkSpend},
 * never by matching on `kind` at each call site.
 */
export type NetworkSpendState =
  /** Not on TOON transport — nothing here costs money. */
  | { kind: "relay" }
  /** TOON is active; the channel read is in flight. */
  | { kind: "pending" }
  /**
   * TOON is active but there is nothing to read: viewing an agent other
   * than the identity this desktop process pays as (no per-agent channel
   * read exists yet — see the module doc), or this identity has never
   * opened a channel.
   */
  | { kind: "unavailable" }
  | {
      kind: "quoted";
      read: NetworkFlowRead;
      /** Where the deposit/owed pair came from — connector-verified or this client's own tracked watermark. */
      source: "claim-state" | "local";
      /** Whether any spend has been observed this session — see {@link networkSpendRunwayCaption}. */
      hasBurnSample: boolean;
    };

/**
 * Combine a channel read with the live burn-rate snapshot into the block's
 * state. `isSelf` gates the whole per-agent read: this desktop process only
 * ever holds a live `ToonClient` for the identity it itself pays as (its own
 * wallet, account index 0) — a managed agent's own `toon-clientd` sidecar
 * tracks its channel independently, and nothing here can read that
 * remotely yet (no spawn/lifecycle for those daemons exists — buzz#79's ADR
 * 0006 — and no account-index lookup is exposed to the frontend). That is a
 * real architectural gap, not a state this function papers over: any other
 * agent honestly reads `unavailable`.
 */
export function deriveNetworkSpendState(input: {
  isToon: boolean;
  isSelf: boolean;
  raw: RawNetworkFlowStatus | null | "pending";
  live: LiveSpendSnapshot;
}): NetworkSpendState {
  if (!input.isToon) return { kind: "relay" };
  if (!input.isSelf) return { kind: "unavailable" };
  if (input.raw === "pending") return { kind: "pending" };
  if (input.raw === null) return { kind: "unavailable" };

  const read: NetworkFlowRead = {
    depositBaseUnits: input.raw.depositTotalBaseUnits,
    owedBaseUnits: input.raw.cumulativeClaimedBaseUnits,
    // No income source is wired here (#80's scope is spend, not earning) —
    // buzz#86's agentNetworkFlow.ts already defaults an absent income to a
    // plain burn-rate-driven runway, so this stays honest rather than
    // fabricating a credited figure.
    creditedBaseUnits: 0n,
    burnRateBaseUnitsPerSec: input.live.burnRateBaseUnitsPerSec,
    incomeRateBaseUnitsPerSec: 0,
    incomeSampleCount: 0,
  };

  return {
    kind: "quoted",
    read,
    source: input.raw.source,
    hasBurnSample: input.live.hasSample,
  };
}

/** Whether the refill action can run — the separate "can I act" answer the state's `kind` alone must not be read as. */
export function canRefillNetworkSpend(state: NetworkSpendState): boolean {
  return state.kind === "quoted";
}

/**
 * The runway caption the block shows under balance/allowance. Burn rate is
 * observed only from this session's own writes (`networkSpendLiveStore.ts`)
 * — with none yet, claiming a runway (finite OR self-funding) would be a
 * guess dressed as a reading, so this says so instead of calling
 * `deriveNetworkRunway` on a zero rate it would otherwise read as
 * "self-funding".
 */
export function networkSpendRunwayCaption(
  read: NetworkFlowRead,
  hasBurnSample: boolean,
): string {
  if (!hasBurnSample) {
    return `${formatUsdcBaseUnits(netSpendableBaseUnits(read))} available — burn rate hasn't been measured yet this session.`;
  }
  return networkRunwayCaption(deriveNetworkRunway(read));
}

/** Render a per-second base-unit rate as a per-minute caption, matching the huddle fee quote's per-minute framing. */
export function formatBurnRatePerMinute(baseUnitsPerSec: number): string {
  const perMinuteBaseUnits = BigInt(Math.round(baseUnitsPerSec * 60));
  return `${formatUsdcBaseUnits(perMinuteBaseUnits)}/min`;
}
