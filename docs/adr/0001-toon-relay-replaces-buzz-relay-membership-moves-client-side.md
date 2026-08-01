---
status: accepted
---

# TOON relay replaces buzz-relay; membership moves client-side

Upstream buzz's relay is an application server — NIP-42 auth, membership ACLs, search, workflows, audit, REST media/git, huddle rooms — and the single source of truth. We replace it with a plain pay-to-write TOON relay behind a connector: writes are paid (that is the spam control), reads are free and public, and the relay enforces nothing about membership. Privacy and membership become cryptography: private channels are encrypted groups keyed by a shared channel key, membership authority lives in a signed admin-list event, and server-side features are rebuilt as agent-members (a key-holding search indexer, a workflow-runner agent) or as TOON-native paths (git via rig, media via the store node — ADR 0002, huddles — ADR 0003).

## Considered options

- **Connector in front of buzz-relay** (keep the app server, add payments at the edge): preserved every feature but kept the trusted server and none of TOON's read-openness; rejected as not actually a migration.
- **Track upstream with a rebased patch stack**: relay removal touches too many files; every sync becomes conflict archaeology. We hard-fork instead, keeping the TOON write path behind a narrow transport seam so upstream UI/feature commits stay cherry-pickable.

## Consequences

- Anyone can read the relay: anything not encrypted is public. Presence/typing chatter is dropped in v1 (paid-per-event makes it absurd; a free ephemeral lane is future connector work).
- Every writer — human or agent — needs an identity, funding, and an open payment channel before their first message (the onboarding wizard). Known blocker: the devnet faucet dispenses no native gas.
- Removed members retain history they already had (Slack-export semantics); rotation protects the future, not the past.
