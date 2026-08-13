# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

Break the issue into an ordered list of small tasks before writing code. For
each task, use RGR:

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until the task is done
4. REFACTOR the code

**Commit AND push after every completed task** — `git push -u origin {{BRANCH}}`
(use `-u`: the branch has not been pushed to origin yet, so a bare `git push`
has no upstream to publish to until the first one sets it; every push after
that reuses it). Do this immediately, before starting the next task and
without waiting for the full gate below. A run that is killed mid-gate or
mid-task then leaves every already-finished task on the remote branch
instead of losing the whole run — see buzz#163. Each task commit only needs
to describe that task; it does not need to satisfy the full COMMIT section
below (that applies to the final commit).

# FEEDBACK LOOPS

buzz is a polyglot repo: a Rust workspace (`crates/*`) plus a pnpm workspace for the JS apps (`desktop` / `web` / `admin-web`), driven by the Justfile. Before committing, run buzz's real gate and make sure every command passes:

- Rust format: `just fmt-check`
- Tauri Rust format: `just desktop-tauri-fmt-check`
- Rust lint: `just clippy` (workspace, `-D warnings` — the first run compiles cold and is slow; that is expected)
- Rust unit tests: `just test-unit` (the infra-free unit set, via cargo-nextest)
- Desktop lint: `just desktop-check`
- Desktop tests: `just desktop-test`
- Desktop build: `just desktop-build` (`tsc && vite build` — this is the desktop typecheck)
- Web lint: `just web-check`
- Web build: `just web-build` (`tsc && vite build` — this is the web typecheck)

JS dependencies were already installed by the sandbox setup hook (`pnpm install --frozen-lockfile`); re-run it only if you changed a `package.json`.

If your change is confined to one side (Rust-only or JS-only), you may run only that side's commands during iteration — but run the FULL list above once after the last task, before your final commit.

OUT OF SCOPE for this gate — do NOT attempt these in the sandbox: Flutter/mobile (`mobile/**`), `desktop/src-tauri` compile-level checks (clippy/check/test need GTK/WebKit system libraries and sidecar stubs the agent image does not ship), Playwright e2e suites, Postgres/Redis-backed integration tests (`just test-integration`, backend-integration, relay-e2e), `cargo-deny`, cross-compilation, and the signing/canary/release pipelines. Upstream `ci.yml` still runs its full matrix on your PR.

Run the full gate once, after all tasks are implemented and pushed per-task
as above. If a gate command fails, fix it, then commit and push the fix as
its own follow-up — do not let a failing gate discard tasks that already
passed and are already on the remote branch.

# COMMIT

Once every task is committed/pushed and the full gate passes, make a final
git commit (and push it) summarizing the whole change. The commit message
must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise. If nothing changed since the last per-task commit (the gate
passed on the first try), this can be that same commit — no separate empty
commit is needed just to satisfy this format.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

## Context budget

Operate as if your context is capped at **~200k tokens**, whatever your model's actual window
is (org policy: toon-meta's `CLAUDE.md` → *Context budget policy* — the cap is absolute, not a
percentage of the window, because a percentage means different things on different models).
Treat ~200k as a hard ceiling, not a target, and do the real work well below it.

Start preparing a handoff at roughly **120k** tokens of context, and hand off no later than
roughly **160k** — never run to the ceiling. Handing off means: write a structured handoff note
(goal and remaining work as a concrete task list; what has been done and where — files,
branches, commits; key decisions and why; exact paths/line numbers instead of "see above") to
`.sandcastle/logs/handoff-<task-id>.md`, **commit it on this branch** (use `git add -f` —
`.sandcastle/.gitignore` ignores `logs/`, and the sandbox is destroyed when the run ends, so an
uncommitted note is lost), and end your turn so a fresh agent continues. Small, resumable units
beat one degraded run.
