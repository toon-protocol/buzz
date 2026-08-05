/**
 * Search-result kind badge label. Extracted from SearchResultItem.tsx so
 * it's testable without pulling in React (buzz#125 added kind:6097).
 */
export function describeSearchHitKind(kind: number): string {
  switch (kind) {
    case 1:
      return "Note";
    case 45001:
      return "Forum post";
    case 45003:
      return "Forum reply";
    case 43001:
      return "Agent job";
    case 43003:
      return "Agent update";
    case 5097:
      return "Agent job";
    case 6097:
      return "Agent job result";
    case 7000:
      return "Agent update";
    case 46010:
      return "Approval request";
    default:
      return "Message";
  }
}
