# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

# CONTEXT

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, unchecked `unwrap()`/`expect()` on fallible paths, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run buzz's gate for the side(s) the diff touches to ensure nothing is broken — Rust: `just fmt-check`, `just desktop-tauri-fmt-check`, `just clippy`, `just test-unit`; JS: `just desktop-check`, `just desktop-test`, `just desktop-build`, `just web-check`, `just web-build`. (Flutter/mobile, `desktop/src-tauri` compile checks, e2e, and infra-backed integration tests are out of scope in the sandbox — upstream `ci.yml` covers them on the PR.)
3. Commit describing the refinements

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.

## Context budget

Operate as if your context is capped at **~200k tokens**, whatever your model's actual window
is (org policy: toon-meta's `CLAUDE.md` → *Context budget policy* — the cap is absolute, not a
percentage of the window). Treat ~200k as a hard ceiling, not a target.

Start preparing a handoff at roughly **120k** tokens of context, and hand off no later than
roughly **160k** — never run to the ceiling. Handing off means: write a structured handoff note
(what you reviewed, what you changed, what is left to check, and exact file/line pointers) to
`.sandcastle/logs/handoff-<task-id>.md`, **commit it on this branch** (use `git add -f` —
`.sandcastle/.gitignore` ignores `logs/`, and the sandbox is destroyed when the run ends, so an
uncommitted note is lost), and end your turn so a fresh agent continues.
