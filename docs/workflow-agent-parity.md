# Workflow agent ↔ `buzz-workflow` parity (buzz#22)

buzz#21 (`crates/buzz-cli/src/workflow_agent`) ported the *idea* of
`crates/buzz-workflow` — the relay's multi-step, DB-backed workflow engine —
into the agent-member idiom: a long-running process that is a *member* of the
channels it acts in, and reads only what it holds a key for. It deliberately
did not port the engine's surface area. buzz#22 (this document) is the parity
audit that decides, feature by feature, what's worth porting now, what's
dropped and why, and what's left for a follow-up.

"PORTED" below means: implemented in the agent-member runner, with tests, as
of this ticket. "DROPPED" means: considered and rejected for the agent-member
runner, with a reason. Nothing in `buzz-workflow`'s surface is silently
omitted — anything not in this table either doesn't exist upstream either, or
is folded into a row below.

## Triggers

| Upstream (`TriggerDef`)        | Agent-member status | Reason |
|---------------------------------|----------------------|--------|
| `message_posted` (+ `filter`)   | **PORTED** (v1, buzz#21) | `trigger.contains` / `trigger.matches`, scoped by `trigger.channel`. |
| `message_posted` boolean filter (`evalexpr`, `&&`/`\|\|`) | **PORTED** (buzz#22, narrower) | `trigger.all` / `trigger.any` — a flat list of `contains`/`matches` conditions, ANDed or ORed. Not a general expression language and not recursive (an `all`/`any` item cannot itself be `all`/`any`) — see `crates/buzz-cli/src/workflow_agent/schema.rs`'s "why not `buzz-workflow`" note: a flat list covers what upstream's `if:` boolean composition buys for *this* condition vocabulary (substring/regex) without pulling in `evalexpr`. |
| `schedule` (`cron` / `interval`) | **PORTED** (buzz#22, cron only) | `trigger.schedule` — a cron expression via the same `cron` crate upstream validates with (already a workspace dependency), normalized the same way (`normalize_cron`: 5/6/7 fields). `interval: "30m"` sugar is **not** ported — a cron expression already expresses every interval upstream's shorthand does, and skipping the sugar keeps one code path instead of two. Follow-up if an author actually wants the shorthand. |
| `diff_posted` (kind:40008, + `filter`) | DROPPED | The agent-member runner has no analogue of a "diff message" kind, and nothing in the buzz-cli surface produces kind:40008 today. Nothing to trigger on; revisit if/when the CLI grows diff-posting. |
| `reaction_added` (kind:7, optional `emoji`) | DEFERRED — buzz#52 | Technically portable (kind:7 reactions are ordinary client-signable events, not relay-privileged), but the agent's tail walk fetches by `#h` channel tag and NIP-25 reactions don't carry one — the relay derives a reaction's channel server-side from its `e`-tag target (`crates/buzz-relay/src/handlers/ingest.rs`'s `derive_reaction_channel`). Reliably scoping "reactions in the channels I hold a key for" needs either a second fetch keyed on the exact message ids already seen (extra relay round trips every cycle) or a relay-side `#h`-tagged reaction convention this codebase doesn't have yet. Worth doing, not free — tracked as a follow-up rather than rushed. |
| `webhook` (HTTP POST to `/hooks/{id}`) | DROPPED | Relay-privileged by construction (a server endpoint at a stable relay-owned URL); the agent-member has no HTTP-server role and buzz#20/#21's whole idiom is "reads only what the relay can prove this identity was admitted to." Nothing to port to. |
| member added/removed (NIP-29 `kind:9000`/`9001`, admin-list role changes) | DEFERRED — buzz#52 | Not in upstream's `TriggerDef` at all, but named explicitly in issue #22 as an example worth considering because it's *observable* from `kind:39100` admin-list events the agent already fetches for encryption resolution (`crate::channel_admins`). What's missing is state: detecting "joined" needs a diff against the *previous* fold of the list (admins added since last seen), which means persisting a per-channel admin-set snapshot in `WorkflowState` and a new walk pass alongside the message tail and the schedule pass added here. Scoped out of this ticket to keep it shippable; the admin-list fold itself (`crate::channel_admins`) is already exactly the primitive a follow-up would build on. Also note: `kind:39100`'s roster is *admins*, not general members — a "member joined" trigger here would really mean "admin added," which is worth calling out to whoever picks up the follow-up. |

## Actions

| Upstream (`ActionDef`)     | Agent-member status | Reason |
|-----------------------------|----------------------|--------|
| `send_message` (`text`, optional `channel`) | **PORTED** (buzz#21 + buzz#22) | `action.reply` (buzz#21) + `action.channel` (buzz#22) — a cross-channel override, or the required destination for a `schedule` trigger. Unlike upstream's `resolve_send_message_channel` (which lets an *unbound* workflow's override be any UUID, no membership check), the agent-member's `act()` refuses the destination outright when this identity holds no key for it — see "Cross-channel authorization is stricter here" below. |
| `add_reaction` (`emoji`) | DEFERRED — buzz#52 | Same relay-shape gap as the `reaction_added` trigger (kind:7 posting itself is trivial — `send_message`'s underlying publish path already works for any kind — but the useful trigger half isn't there yet, and an action with nothing that can fire it isn't worth shipping alone). Bundle with the `reaction_added` follow-up. |
| `set_channel_topic` (`topic`) | DROPPED | **Upstream hasn't implemented this either** — `crates/buzz-workflow/src/executor.rs`'s `dispatch_action` returns `WorkflowError::NotImplemented("SetChannelTopic")` with a `TODO (WF-07)`. Nothing to port; parity with an unimplemented upstream action is trivially "also unimplemented." |
| `send_dm` (`to`, `text`) | DROPPED | Also unimplemented upstream (`NotImplemented("SendDm")`, same `TODO (WF-07)`). Same reasoning as `set_channel_topic`. |
| `call_webhook` (`url`, `method`, `headers`, `body`, SSRF-hardened) | DROPPED | Upstream *is* implemented here, behind SSRF hardening (`check_ssrf`, DNS-pinning, redirect denial, response-size caps — real security work, `crates/buzz-workflow/src/executor.rs`). Porting it properly means porting all of that, for a feature that isn't TOON-shaped: it's an arbitrary external side effect, not a payment-channel write, and upstream itself gates it behind elevated (owner/admin) authority (`WorkflowDef::requires_elevated_authority`, SEC-006) specifically because it can exfiltrate channel content to any URL an author names. The agent-member idiom (schema.rs's own "why not `buzz-workflow`" note) is deliberately narrow — one trigger, one action, no surface not in active use. Worth a dedicated ticket if a real use case shows up, not a half-ported SSRF surface bolted on here. |
| `request_approval` (`from`, `message`, `timeout`, suspend/resume) | DROPPED (per issue #22's own guidance) | Needs an approval UI and a resumable run — desktop's `WorkflowApprovalCard.tsx` / `kind:46010`/`46011`/`46012` and DB-backed run suspension, none of which the agent-member has or should grow just for this. Explicitly called out in the ticket as an expected drop. |
| `delay` (`duration`, capped at 270s) | DROPPED | Meaningful for a multi-step *sequential* run (delay between step N and N+1) — the agent-member has exactly one action per trigger, so there is no "next step" to delay before. Nothing to port to until/unless the agent-member grows multi-step actions, which is a bigger redesign than this ticket. |

## Condition semantics

| Upstream | Agent-member status | Reason |
|----------|----------------------|--------|
| `evalexpr` boolean expressions (`&&`, `\|\|`, `!`, comparisons, `str_contains`/`str_starts_with`/`str_ends_with`/`str_len`, step-output references) | **PARTIALLY PORTED** (buzz#22: `all`/`any` composition) | See the "condition composition" trigger row above. Comparisons against non-string values, step-output references (`steps.ID.output.FIELD`), and template filters (`truncate`, `npub`) are all **DROPPED**: the agent-member has no multi-step run to have step outputs from, and `{{trigger.X}}` templating was never part of v1's one-line `reply:` string. Porting a real expression evaluator for a runner whose whole condition surface is "does this text contain/match this" would be exactly the "carrying its whole surface" schema.rs's module doc says v1 is deliberately not doing. |
| Per-step `if:` (skip-not-fail) | DROPPED | No steps to skip — the agent-member is trigger → one action, not a step sequence. |

## Loop prevention

| Upstream mechanism | Agent-member status | Reason |
|---|---|---|
| `is_workflow_execution_kind` (kinds 46001–46012: triggered/step-started/step-completed/step-failed/completed/failed/cancelled/approval-*) excluded from re-triggering workflows | **PORTED, adapted** (buzz#22) | The agent-member has no analogous *kinds* — every action is an ordinary kind:9 channel message, relay-privileged execution-state kinds don't exist in this surface. The adapted equivalent is [`is_workflow_action_event`](../crates/buzz-cli/src/workflow_agent/mod.rs): any event carrying the `["client", "buzz-workflow"]` marker tag is excluded from triggering, regardless of kind or author. buzz#21 wrote this tag on every action but never read it back; buzz#22 is what makes it mean something. |
| Relay-signed event + `buzz:workflow` tag check (`is_relay_workflow_msg` in `crates/buzz-relay/src/handlers/event.rs`) | **PORTED, adapted** | Upstream's actions are signed by the *relay's own keypair*, so "is this a workflow's own output" collapses to "is the signer the relay AND does it carry the tag." The agent-member has no relay keypair to check against — every action is signed by the agent's own identity — so the adapted check is tag-only, deliberately independent of signer: it is the multi-runner leg (buzz#21's own module doc flagged this gap by name as the thing buzz#22 should close). See `mod.rs`'s "Loop prevention" section for the full three-mechanism breakdown (`is_own_event`, `is_workflow_action_event`, and the fact that both compose to terminate a cross-triggering pair in one hop). |
| `is_command_kind` exclusion (workflow *definition*/trigger-request kinds: 30620, 46020, etc.) | N/A | These are relay-side control-plane kinds for *authoring* workflows over Nostr (`kind:30620` workflow defs, `kind:46020` manual trigger requests) — the agent-member has no Nostr-authored-workflow surface at all; definitions are local YAML files. Nothing to exclude because nothing produces these kinds here. |

## Cross-channel authorization is stricter here — a deliberate divergence, not a gap

Upstream's `resolve_send_message_channel` lets an *unbound* workflow (no
`workflow.channel_id`) post to any UUID named in `channel:`, validated only as
"is this a well-formed UUID," with no membership check at the action layer —
authority is enforced elsewhere in that engine (the community/tenant boundary
and, for `call_webhook`, `requires_elevated_authority`).

The agent-member's `act()` (buzz#22) is intentionally narrower: **a
cross-channel action refuses outright unless this identity holds a key for
the destination**, even for a channel that would otherwise accept an
unkeyed/plaintext post from a human running `buzz toon send`. An unattended
process firing on a timer or on every matching message is a different risk
profile than a human typing a command, and "the workflow YAML names a
channel" is not, by itself, enough authority to make an agent post there
automatically. This is documented in `act()`'s doc comment and exercised by
`crates/buzz-cli/tests/workflow_agent.rs`'s
`a_cross_channel_action_the_runner_holds_no_key_for_is_refused`.

## Summary

- **Shipped this ticket:** `trigger.schedule` (cron), `trigger.all`/`trigger.any`
  (AND/OR composition), `action.channel` (cross-channel override, key-gated),
  and the multi-runner leg of loop prevention (`is_workflow_action_event`).
- **Deferred, filed as follow-up:** `reaction_added` trigger + `add_reaction`
  action (relay reaction-scoping gap), member-joined/admin-added trigger
  (needs an admin-list diff pass + new persisted state) — buzz#52.
- **Dropped, upstream is also missing it:** `set_channel_topic`, `send_dm`.
- **Dropped, needs infrastructure the agent-member doesn't have and
  shouldn't grow for this:** `call_webhook` (SSRF-hardened HTTP),
  `request_approval` (suspend/resume + UI), `delay` (no multi-step run),
  full `evalexpr` condition language, step-output templating.
