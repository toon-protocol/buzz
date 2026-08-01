# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run buzz's gate for the side(s) the merged changes touch to verify everything works — Rust: `just fmt-check`, `just desktop-tauri-fmt-check`, `just clippy`, `just test-unit`; JS: `just desktop-check`, `just desktop-test`, `just desktop-build`, `just web-check`, `just web-build`. (Flutter/mobile, `desktop/src-tauri` compile checks, e2e, and infra-backed integration tests are out of scope in the sandbox.)
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`gh issue close <ID> --comment "Completed by Sandcastle"`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
