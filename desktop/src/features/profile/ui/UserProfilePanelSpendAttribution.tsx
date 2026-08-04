import { ListTree } from "lucide-react";

import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import type { NetworkSpendState } from "@/features/profile/lib/networkSpendState";
import { useAgentSpendAttribution } from "@/features/profile/lib/useAgentSpendAttribution";

/**
 * Spend attribution block (buzz#78) — the connector's authoritative total,
 * broken down by chat channel and event kind from relay-observed events,
 * with the gap surfaced as an explicit unattributed remainder rather than
 * redistributed across the breakdown (spend in channels the owner cannot
 * see is real and should read as real, not silently absorbed).
 *
 * `isSelf`-gated for the same reason `NetworkSpendSection` is: reconciling
 * needs a connector total, and only the identity this desktop process pays
 * as has one today (see `networkSpendState.ts`'s module doc). The
 * channel/kind breakdown itself does not need `isSelf` — see
 * `agentSpendAttribution.ts`'s module doc — but without a total to
 * reconcile against there is nothing yet to call an "attribution" in the
 * sense this block promises, so it stays hidden rather than showing a
 * breakdown with no total behind it.
 */
export function SpendAttributionSection({
  agentPubkey,
  isSelf,
  network,
}: {
  agentPubkey: string;
  isSelf: boolean;
  network: NetworkSpendState;
}) {
  const attribution = useAgentSpendAttribution({
    agentPubkey,
    isSelf,
    network,
  });

  if (!isSelf) return null;
  if (attribution.isLoading) {
    return (
      <section
        className="space-y-2"
        data-testid="user-profile-money-spend-attribution"
      >
        <h3 className="px-1 text-sm font-semibold text-foreground">
          Spend by channel
        </h3>
        <p className="px-1 text-sm text-muted-foreground">
          Loading spend attribution…
        </p>
      </section>
    );
  }

  if (attribution.isError) {
    return (
      <section
        className="space-y-2"
        data-testid="user-profile-money-spend-attribution"
      >
        <h3 className="px-1 text-sm font-semibold text-foreground">
          Spend by channel
        </h3>
        <p
          className="px-1 text-sm text-muted-foreground"
          data-testid="user-profile-money-spend-attribution-error"
        >
          Spend attribution couldn't be loaded.
        </p>
      </section>
    );
  }

  if (!attribution.breakdown || !attribution.reconciliation) return null;

  const { breakdown, reconciliation } = attribution;

  return (
    <section
      className="space-y-2"
      data-testid="user-profile-money-spend-attribution"
    >
      <h3 className="px-1 text-sm font-semibold text-foreground">
        Spend by channel
      </h3>
      {breakdown.byChannelKind.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          No attributable spend observed yet.
        </p>
      ) : (
        <ul
          className="space-y-1 rounded-2xl bg-muted/20 px-4 py-3"
          data-testid="user-profile-money-spend-attribution-rows"
        >
          {breakdown.byChannelKind.map((entry) => (
            <li
              className="flex items-center justify-between gap-3 text-sm"
              key={`${entry.channelId}-${entry.kind}`}
            >
              <span className="flex items-center gap-2 text-muted-foreground">
                <ListTree className="h-4 w-4 shrink-0" />
                {entry.channelId} · kind {entry.kind} · {entry.eventCount}{" "}
                {entry.eventCount === 1 ? "event" : "events"}
              </span>
              <span className="font-medium text-foreground">
                {formatUsdcBaseUnits(entry.baseUnits)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {reconciliation.kind === "reconciled" ? (
        <p
          className="px-1 text-xs text-muted-foreground"
          data-testid="user-profile-money-spend-attribution-remainder"
        >
          {formatUsdcBaseUnits(reconciliation.connectorTotalBaseUnits)} spent in
          total —{" "}
          {formatUsdcBaseUnits(reconciliation.unattributedRemainderBaseUnits)}{" "}
          unattributed (channels this device can't see).
        </p>
      ) : null}
    </section>
  );
}
