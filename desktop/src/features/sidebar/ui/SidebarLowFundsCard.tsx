import * as React from "react";
import { BatteryWarning } from "lucide-react";

import { countLowFundsAgents } from "@/features/agents/lib/agentFleetRunway";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useAgentFleetRunwayBadges } from "@/features/agents/lib/useAgentFleetRunwayBadges";
import { shouldShowSidebarLowFundsCard } from "@/features/sidebar/ui/sidebarLowFundsCardVisibility";
import { SidebarCompactActionCard } from "@/shared/ui/sidebar-action-card";

type SidebarLowFundsCardProps = {
  onOpenFleet: () => void;
};

/**
 * The fleet low-funds alert (buzz#76) — same `SidebarCompactActionCard`
 * idiom as `SidebarRelayConnectionCard`: icon, title, one action,
 * dismissible, `role=alert`. Appears only once at least one agent's runway
 * has crossed a warning threshold; see `agentFleetRunway.ts` for why that
 * is `0` for almost every agent today (no per-agent channel read yet).
 */
export function SidebarLowFundsCard({ onOpenFleet }: SidebarLowFundsCardProps) {
  const agentsQuery = useManagedAgentsQuery();
  const agents = agentsQuery.data ?? [];
  const runwayBadges = useAgentFleetRunwayBadges(agents);
  const count = React.useMemo(
    () => countLowFundsAgents(runwayBadges.values()),
    [runwayBadges],
  );
  const [dismissedAtCount, setDismissedAtCount] = React.useState<number | null>(
    null,
  );

  if (!shouldShowSidebarLowFundsCard(count, dismissedAtCount)) {
    return null;
  }

  return (
    <div className="mb-2 group-data-[collapsible=icon]:hidden">
      <SidebarCompactActionCard
        actionAriaLabel="Review agents low on funds"
        actionTestId="sidebar-low-funds-review"
        description="Click to review the fleet."
        dismissLabel="Dismiss low-funds notification"
        icon={<BatteryWarning aria-hidden="true" className="h-5 w-5" />}
        onAction={onOpenFleet}
        onDismiss={() => setDismissedAtCount(count)}
        role="alert"
        testId="sidebar-low-funds"
        title={`${count} agent${count === 1 ? "" : "s"} low on funds`}
      />
    </div>
  );
}
