# Coding Standards — buzz

Loaded by the reviewer agent during code review (`@.sandcastle/CODING_STANDARDS.md`), so these
are enforced at review time without costing implementation tokens.

buzz is a fork of `block/buzz` carrying the TOON migration (see `NOSTR.md`, plus `CONTEXT.md`
and `docs/adr/` once buzz#8 lands). The upstream repo's own agent guidance applies too: read
`AGENTS.md` and `CLAUDE.md` at the repo root before large changes, and `CONTRIBUTING.md` for
workflow rules.

## Style

- **Rust** (`crates/*`): formatting is `cargo fmt` (checked by `just fmt-check`); lint budget is
  zero — `just clippy` runs `-D warnings` across the workspace. No `unwrap()`/`expect()` on
  fallible paths in non-test code; prefer `?` and typed errors (`thiserror`). Follow the
  existing crate layout — one responsibility per crate.
- **TypeScript** (`desktop`, `web`, `admin-web`): Biome is the formatter and linter
  (`just desktop-check` / `just web-check`); do not hand-format. `tsc --noEmit` must stay
  clean (it runs inside `pnpm build`). Named exports over default exports.
- Keep the repo's file-size discipline: `check:file-sizes` is part of the desktop/web check —
  split modules rather than growing files past the budget.

## Testing

- Rust: unit tests live with their crates; the sandbox gate runs the infra-free set
  (`just test-unit`). Tests that need Postgres/Redis are `#[ignore]`d or live in integration
  suites — do not un-ignore them in the sandbox.
- Desktop TS helpers: `node --test` specs (`desktop/src/**/*.test.mjs`) run via
  `just desktop-test`. New helper logic gets a spec.
- Test names state the expected behavior, not the implementation.

## Architecture

- The relay (`crates/buzz-relay`) is Nostr-native; protocol behavior follows the NIPs
  documented in `NOSTR.md`. Do not invent wire formats — extend via documented NIPs/ADRs.
- Desktop (Tauri) and web share idioms but not code paths with the relay; keep changes scoped
  to one surface per issue.
- Migration-direction decisions live in `docs/adr/` — consult them before changing anything
  they cover (relay swap, store media, groups encryption, etc.).
