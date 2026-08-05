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
   * TOON is active but there is nothing to read: this identity has never
   * opened a channel, no channel was ever discovered for it (buzz#109 —
   * `docs/adr/0007`), or (Solana) this agent's chain is out of this read
   * path's scope.
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
 * state. `unavailable` now falls out of `raw === null` alone — the caller
 * (`useNetworkSpend.ts`) is responsible for producing that `null` honestly,
 * whether the reason is "not on TOON", "no channel for this identity yet",
 * or (for a non-`isSelf` agent, buzz#109 / `docs/adr/0007`) "no channel was
 * ever discovered for this agent's derived address" or "the connector could
 * not verify this agent's challenge". This function does not need to know
 * which — every one of those is the same honest non-answer.
 */
export function deriveNetworkSpendState(input: {
  isToon: boolean;
  raw: RawNetworkFlowStatus | null | "pending";
  live: LiveSpendSnapshot;
}): NetworkSpendState {
  if (!input.isToon) return { kind: "relay" };
  if (input.raw === "pending") return { kind: "pending" };
  if (input.raw === null) return { kind: "unavailable" };

  const read: NetworkFlowRead = {
    depositBaseUnits: input.raw.depositTotalBaseUnits,
    owedBaseUnits: input.raw.cumulativeClaimedBaseUnits,
    // Fed straight from the same claim-state read as deposit/owed (buzz#108)
    // — always 0n for `source: "local"`, since the locally-tracked watermark
    // only knows this client's own spend, never a connector-applied credit.
    // Income RATE (burnRate's earning-side counterpart) is a separate,
    // still-unwired gap: no live event feed exists for inbound payments,
    // only `networkSpendLiveStore.ts`'s outbound `onPaidWrite` — so runway
    // still degrades to burn-only until that lands.
    creditedBaseUnits: input.raw.creditedBaseUnits,
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
