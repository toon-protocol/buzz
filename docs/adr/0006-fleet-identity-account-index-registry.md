---
status: accepted
---

# Fleet identity: a desktop-local account-index registry, never reused

Every managed agent gets its own persisted BIP-44 account index, assigned once at creation and stable for the life of the agent, so its `toon-clientd` sidecar (ADR 0005) derives a payment key distinct from the owner's own wallet (index 0) and from every other agent's. The desktop supervisor is the assignor: `desktop/src-tauri/src/managed_agents/account_index.rs` persists an append-only `agent pubkey -> account index` registry at `<app_data_dir>/agents/account-index-registry.json`, assigns the next unused index at agent creation (`create_managed_agent`), and hands it to the spawned `buzz-acp` process as `BUZZ_TOON_ACCOUNT_INDEX` (`spawn_agent_child`, idempotent per pubkey — also a lazy-migration path for agents created before this registry existed).

This is buzz#79, the fleet-decomposition follow-up ADR 0005 flagged as out of scope for buzz#73.

## Considered options

- **Store the index on `ManagedAgentRecord` itself** (`managed-agents.json`): rejected as the sole source of truth — `delete_managed_agent` hard-removes a record (`records.retain(...)`), so a deleted agent's index would vanish with it. The "never reuse an index, including for deleted agents" requirement needs a store that outlives the agent record. (The registry does not duplicate the index onto the record either, to avoid two sources of truth silently drifting; a future reader that needs the index looks it up by pubkey.)
- **A relay-side registry** (a `buzz-db`/Postgres table, or a kind under `buzz-core::kind`): rejected — a fleet's account-index space is scoped to one operator's desktop host and one owner seed, independent of which community/relay an agent happens to be joined to. Publishing index assignments as Nostr events would also put payment-identity bookkeeping on a multi-tenant relay for no operational benefit.
- **Desktop-local, append-only JSON registry, tombstone-not-delete** (chosen): mirrors `managed-agents.json`'s own storage shape (`atomic_write_json_restricted`, owner-only file mode) and lock discipline (a process-local mutex around read-modify-write; cross-process contention between two desktop instances is an accepted risk here, same as for `managed-agents.json` itself). Deleting an agent sets `deleted_at` on its entry instead of removing it, so the index is permanently retired rather than reassigned.

## Consequences

`BUZZ_TOON_ACCOUNT_INDEX` moves from `env_vars::RESERVED_ENV_KEYS` — it is now supervisor-assigned per agent, and a user-supplied override in the agent/persona env-vars UI could otherwise collide two agents onto the same derived payment identity. `BUZZ_TRANSPORT` and `TOON_DAEMON_URL` are unaffected: an operator still opts a given agent into TOON transport (and points it at that agent's own `toon-clientd` sidecar URL) via the existing env-vars override, same as buzz#73. This ADR does not add Rust or TS code to spawn `toon-clientd` daemons themselves — no code anywhere in this repo does that today (§5 of the buzz#79 research), and the accepted registry scope is index bookkeeping plus env wiring, matching the issue's literal "spawn-time wiring so the managed-agent supervisor hands each `buzz-acp` process its own index."

### Recovery when the registry is lost

Because every agent's payment key derives from the *owner's* seed at that agent's account index, losing `account-index-registry.json` does not lose any funds — it only loses the desktop's own bookkeeping of which index belongs to which agent. Recovery is a scan:

1. Recover the owner's mnemonic (the same phrase the onboarding wizard generated/imported — see `desktop/README.md`'s `BUZZ_TOON_MNEMONIC` row).
2. For increasing account indices starting at 1 (index 0 is the owner's own wallet, never an agent's), derive the identity at each index with `@toon-protocol/client`'s `deriveFullIdentity(mnemonic, index)` — the same call `toonOnboardingIdentity.ts` makes for the owner's own wallet — and check the resulting address for an on-chain balance or an existing/resumable TOON payment channel (`toon-clientd`'s `/status`, or the connector's claim-state endpoint per the fleet-money epic).
3. An index with funds or a channel is a live (or recently live) agent identity; settle/reclaim its channel through that same derived key. An index with neither, after a reasonable run of consecutive empty indices (e.g. 20), marks the end of the fleet that ever existed on this host.
4. To resume normal operation rather than one-off reclaim, rebuild `account-index-registry.json` by writing one entry per funded/channel-bearing index found, with `pubkey` set to the corresponding still-known agent identity if it's recoverable (e.g. from `managed-agents.json` or the relay's own agent-profile events), or a placeholder if the agent record itself is also gone — the important invariant to preserve is that the next fresh agent creation continues from `max(recovered indices) + 1`, not from 1, so it can never re-collide with a recovered-but-unlisted index.

No index-scanning code lives in this repo: the derivation call is a thin wrapper around `@toon-protocol/client` (already a runtime dependency of the desktop app for onboarding), and the balance/channel check is the same `toon-clientd`/connector read every other TOON balance surface in this epic already uses. This procedure is intentionally a documented manual runbook rather than new automated tooling — recovery is rare, operator-driven, and safety-critical enough that an explicit review of what's found beats a script silently rewriting the registry.
