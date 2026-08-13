// Shared closing-keyword convention for factory PR bodies (buzz#170).
//
// Every fleet repo's `agent:implement` runner writes a same-repo GitHub
// closing keyword (`Closes #n` / `Fixes #n` / `Resolves #n`) into the PR body
// it opens, so that merging the PR closes its ticket and fires the unblock
// dispatcher, AND so the reviewer (review-verdict.ts's resolveIssueFromPrBody)
// can resolve the Spec-axis target issue deterministically. Both the
// resolver and the runner's fail-loud post-create guard must agree on
// exactly which text counts, so they share this one regex.

export const CLOSING_KEYWORD_RE =
  /\b(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))[ \t]*:?[ \t]+#(\d+)/i;

/**
 * Returns the issue number referenced by a same-repo closing keyword in
 * `body` (e.g. "Closes #170" -> "170"), or null if none is present.
 */
export function matchClosingKeywordIssueNumber(body) {
  const match = body.match(CLOSING_KEYWORD_RE);
  return match ? match[1] : null;
}
