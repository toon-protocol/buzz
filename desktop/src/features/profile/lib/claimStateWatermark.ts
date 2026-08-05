/**
 * Split a connector claim-state watermark into the two non-negative buckets
 * `RawNetworkFlowStatus` carries (`spendable = deposit − owed + credited`,
 * toon-meta#262 decision 9).
 *
 * `cumulativeClaimed` is the connector's NETTED watermark for one channel
 * (`@toon-protocol/client`'s "Earning" docs — earnings net off-chain on the
 * same channel a client spends from, there is no separate earned ledger), so
 * it can read below zero once an identity has been credited more than it has
 * spent. Shared by `toonPaidWriter.ts`'s single-identity `tryClaimState` and
 * `agentClaimStateRead.ts`'s batched per-agent read (buzz#109) — the split
 * math is identical for both callers.
 */
export function splitClaimStateWatermark(result: {
  depositTotal: string | null;
  cumulativeClaimed: string;
}): {
  depositTotalBaseUnits: bigint;
  cumulativeClaimedBaseUnits: bigint;
  creditedBaseUnits: bigint;
} | null {
  if (result.depositTotal === null) return null;
  const cumulativeClaimed = BigInt(result.cumulativeClaimed);
  return {
    depositTotalBaseUnits: BigInt(result.depositTotal),
    cumulativeClaimedBaseUnits: cumulativeClaimed > 0n ? cumulativeClaimed : 0n,
    creditedBaseUnits: cumulativeClaimed < 0n ? -cumulativeClaimed : 0n,
  };
}
