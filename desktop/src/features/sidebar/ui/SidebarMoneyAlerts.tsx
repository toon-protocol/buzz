import { SidebarLowFundsCard } from "@/features/sidebar/ui/SidebarLowFundsCard";
import { SidebarRefillCeilingReachedCard } from "@/features/sidebar/ui/SidebarRefillCeilingReachedCard";

/**
 * Groups the sidebar's money-related alerts — buzz#76 low funds and
 * buzz#132 ceiling-reached — behind one mount point. `AppSidebar.tsx` is
 * already at the desktop file-size ceiling (`check:file-sizes` ratchet), so
 * a second card gets its own file and joins here rather than as another
 * top-level import + JSX line there.
 */
export function SidebarMoneyAlerts({
  onOpenFleet,
}: {
  onOpenFleet: () => void;
}) {
  return (
    <>
      <SidebarLowFundsCard onOpenFleet={onOpenFleet} />
      <SidebarRefillCeilingReachedCard onOpenMoney={onOpenFleet} />
    </>
  );
}
