/**
 * Whether the fleet low-funds `SidebarCompactActionCard` should show
 * (buzz#76). Mirrors `sidebarUpdateCardVisibility.ts`'s shape: a pure
 * predicate the card component gates on, kept dismissed until the count
 * actually gets worse than what the user already dismissed — a rescued
 * agent dropping the count should not immediately re-trigger the same
 * alert the user just cleared.
 */
export function shouldShowSidebarLowFundsCard(
  count: number,
  dismissedAtCount: number | null,
): boolean {
  if (count <= 0) return false;
  if (dismissedAtCount === null) return true;
  return count > dismissedAtCount;
}
