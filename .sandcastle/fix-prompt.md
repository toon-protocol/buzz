# TASK

Repair pull request #{{PR_NUMBER}} on branch `{{BRANCH}}` so its checks pass and it is
mergeable.

You were dispatched by the factory's PR repair pass (toon-meta#357): this PR's ONLY
blocker(s) are a merge conflict and/or failing checks — every other precondition
(approval, review state, `needs:human`) already holds. Make the smallest change that
gets it green; do not expand scope.

# DIAGNOSE

First, find out exactly why this PR is red:

    gh pr view {{PR_NUMBER}} --json mergeable,statusCheckRollup

- If `mergeable` is `CONFLICTING`, resolve the conflict against `main` (see CONFLICTS
  below).
- For every failing check, read its logs before touching anything:

      gh run view <run-id> --log-failed

  (`<run-id>` is the numeric id in the failing check's `detailsUrl`.)

# CONFLICTS

If the PR conflicts with `main`:

    git fetch origin main
    git merge origin/main

Resolve conflicts by reading BOTH sides and choosing the resolution that preserves both
changes' intent (the same convention `.sandcastle/merge-prompt.md` uses) — never blindly
take "ours" or "theirs". If a conflict needs a judgement call only a human should make,
say so plainly in your final output instead of guessing.

# FAILING CHECKS

This is **buzz** — a polyglot repo: a Rust workspace (`crates/*`) plus a pnpm workspace
for the JS apps (`desktop` / `web` / `admin-web`), driven by the Justfile. Reproduce the
side that failed (the full sandbox-runnable gate, from ci.yml):

- Rust format: `just fmt-check`
- Tauri Rust format: `just desktop-tauri-fmt-check`
- Rust lint: `just clippy` (workspace, `-D warnings` — the first run compiles cold and
  is slow; that is expected)
- Rust unit tests: `just test-unit` (the infra-free unit set, via cargo-nextest)
- Desktop lint: `just desktop-check`
- Desktop tests: `just desktop-test`
- Desktop build: `just desktop-build` (`tsc && vite build` — this is the desktop
  typecheck)
- Web lint: `just web-check`
- Web build: `just web-build` (`tsc && vite build` — this is the web typecheck)

JS dependencies were already installed by the sandbox setup hook
(`pnpm install --frozen-lockfile`); re-run it only if you changed a `package.json`.

OUT OF SCOPE in the sandbox — do NOT attempt to reproduce these locally:
Flutter/mobile (`mobile/**`), `desktop/src-tauri` compile-level checks (clippy/check/
test need GTK/WebKit system libraries and sidecar stubs the agent image does not ship),
Playwright e2e suites, Postgres/Redis-backed integration tests (`just
test-integration`, backend-integration, relay-e2e), `cargo-deny`, cross-compilation,
and the signing/canary/release pipelines. If one of THOSE is the failing check,
diagnose from its uploaded logs (`gh run view <run-id> --log-failed`) and reason about
the code — or, if it cannot be fixed blind, say so plainly in your final output.

The `Agent image` check (a build-only check over `.sandcastle/Dockerfile`) runs only on
PRs touching `.sandcastle/**` or that workflow itself.

Fix the ROOT CAUSE of the failure, not the symptom — e.g. a real clippy finding means
fix the code, not `#[allow]` it away. If a failing check looks like infrastructure
flakiness (a CDN, package registry, or setup-step timeout with no code-level cause —
buzz's e2e yo-yo flake is a known example), say so plainly in your final output instead
of inventing a change just to make the diff "look different."

# EXECUTION

1. Diagnose the actual cause before editing anything.
2. Make the smallest change that fixes it.
3. Re-run the failing part of the gate locally (in the order above) and confirm it
   passes before you consider the job done.
4. Commit on the current branch (`{{BRANCH}}`) — this is the PR's own branch; do not open
   a new PR.
5. Do not touch anything outside what's needed to turn this PR green.

Once you've made your fix commit(s) (or determined the failure is not fixable from this
branch — say so clearly in your final output), output <promise>COMPLETE</promise>.
