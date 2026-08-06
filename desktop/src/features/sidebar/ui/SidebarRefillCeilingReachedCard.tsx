import * as React from "react";
import { ShieldAlert } from "lucide-react";

import {
  currentUtcMonthKey,
  getAgentAutoRefillVersion,
  getAutoRefillConfig,
  getRemainingCeilingBaseUnits,
  subscribeToAgentAutoRefillState,
} from "@/features/agents/lib/agentAutoRefillStore";
import { deriveAgentFleetRunwayBadge } from "@/features/agents/lib/agentFleetRunway";
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import { useIdentityQuery } from "@/shared/api/hooks";
import { SidebarCompactActionCard } from "@/shared/ui/sidebar-action-card";

type SidebarRefillCeilingReachedCardProps = {
  onOpenMoney: () => void;
};

/**
 * buzz#132 AC3: ceiling exhaustion surfaces as a visible alert — distinct
 * from `SidebarLowFundsCard`'s "low funds" message, because the fix is
 * different. Low funds is resolved by enabling auto-refill; ceiling-reached
 * means auto-refill already ran and hit its bound, so the only actions left
 * are raising the ceiling or topping up manually.
 *
 * Only ever applies to this desktop process's own identity — auto-refill
 * deposits are `isSelf`-only (`useNetworkSpend.ts`), so this is a single
 * agent's alert, not a fleet count like `SidebarLowFundsCard`.
 */
export function SidebarRefillCeilingReachedCard({
  onOpenMoney,
}: SidebarRefillCeilingReachedCardProps) {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const network = useNetworkSpend(currentPubkey ?? "", true);
  // Re-renders this card when the ceiling/ledger changes elsewhere (e.g. the
  // Money tab's opt-in toggle).
  React.useSyncExternalStore(
    subscribeToAgentAutoRefillState,
    getAgentAutoRefillVersion,
  );

  const [dismissedForMonth, setDismissedForMonth] = React.useState<
    string | null
  >(null);

  if (!currentPubkey) return null;

  const config = getAutoRefillConfig(currentPubkey);
  if (!config.enabled) return null;

  // `null` only means "not opted in", already ruled out just above.
  const remaining = getRemainingCeilingBaseUnits(currentPubkey) ?? 0n;
  if (remaining > 0n) return null;

  // Ceiling is exhausted, but only alert while it's actually the reason
  // runway is at risk — a healthy agent with a maxed-out ceiling from an
  // earlier rescue is not something to alarm about.
  if (!deriveAgentFleetRunwayBadge(network.state)) return null;

  const monthKey = currentUtcMonthKey();
  if (dismissedForMonth === monthKey) return null;

  return (
    <div className="mb-2 group-data-[collapsible=icon]:hidden">
      <SidebarCompactActionCard
        actionAriaLabel="Open Money settings to raise the ceiling or top up manually"
        actionTestId="sidebar-refill-ceiling-reached-review"
        description="Raise the ceiling or top up manually to keep it running."
        dismissLabel="Dismiss ceiling-reached notification"
        icon={<ShieldAlert aria-hidden="true" className="h-5 w-5" />}
        onAction={onOpenMoney}
        onDismiss={() => setDismissedForMonth(monthKey)}
        role="alert"
        testId="sidebar-refill-ceiling-reached"
        title="Auto-refill stopped — monthly ceiling reached"
      />
    </div>
  );
}
