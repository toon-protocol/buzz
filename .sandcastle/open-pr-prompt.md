# TASK

Confirm branch `{{BRANCH}}` is published and open a pull request against
`main` for issue #{{TASK_ID}} ({{ISSUE_TITLE}}). **Do NOT merge anything. Do
NOT close the issue.** A human reviews and merges the PR.

# STEPS

1. Confirm you are on branch `{{BRANCH}}` and that it has commits ahead of
   `main`:

   !`git rev-parse --abbrev-ref HEAD`
   !`git log main..{{BRANCH}} --oneline`

   If there are no commits ahead of `main`, output `<promise>COMPLETE</promise>`
   and stop — there is nothing to open a PR for.

2. The runner already pushed this branch to origin moments ago, using a
   credential minted fresh for that push (toon-meta#331/#248). **Do NOT run
   `git push` yourself** — the container's own git credential helper
   (`gh auth setup-git`, wired at sandbox start) still holds the token from
   job start, which may be stale by now on a long run; re-pushing with it
   could fail even though the branch is already up to date on origin.

3. CONFIRM the remote ref actually exists instead:

   `git ls-remote --heads origin {{BRANCH}}`

   If `git ls-remote` prints NO line for `{{BRANCH}}`, the push the runner did
   before this step FAILED. Do **not** output `<promise>COMPLETE</promise>`.
   Instead print what you see and stop — the runner will detect the missing
   PR and fail the job.

4. Check whether a PR for this branch already exists:

   `gh pr list --head {{BRANCH}} --state open --json number --jq '.[].number'`

   - If one already exists, leave it as-is (do not open a duplicate) and go to
     step 6 to verify.
   - Otherwise open a new PR (step 5).

5. Open the PR:

   ```
   gh pr create \
     --base main \
     --head {{BRANCH}} \
     --title "{{ISSUE_TITLE}}" \
     --body "<body below>"
   ```

   PR body must:
   - Start with a one-line summary of what changed.
   - Reference the issue with `Closes #{{TASK_ID}}`. The merge itself is the
     reviewed, gated event (factory-ops submits the formal verdict before a
     human merges) — the closing keyword is what makes the merge close the
     ticket and fire the unblock dispatcher, and it is also how the reviewer
     resolves the Spec axis (`review-verdict.ts`'s `resolveIssueFromPrBody`).
   - Note that this PR was produced by the sandcastle `agent:implement` runner
     and is awaiting human review.
   - End with the line:
     `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

6. VERIFY a PR now exists before claiming success:

   `gh pr list --head {{BRANCH}} --state open --json number,url`

   If this prints an empty list (`[]`), the push or PR creation did NOT land.
   Do **not** output `<promise>COMPLETE</promise>` — print what went wrong and
   stop.

# RULES

- Never run `git merge`, `gh pr merge`, or `gh issue close`.
- Do not modify code here — implementation and review already happened on this
  branch. This step only confirms the branch is published and opens the PR.
- Only output `<promise>COMPLETE</promise>` once you have CONFIRMED (step 3 +
  step 6) that the branch is on origin AND an open PR exists. A missing ref or
  a missing PR is a failure, not a COMPLETE.

Once the branch is confirmed on origin and an open PR is confirmed to exist,
output `<promise>COMPLETE</promise>`.
