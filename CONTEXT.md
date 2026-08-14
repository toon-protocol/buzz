# Buzz on TOON

Glossary for the buzz fork's migration to TOON — a workspace for humans and agents rebuilt on pay-to-write Nostr over Interledger. Terms only; decisions live in `docs/adr/`.

## Language

**Community**:
The workspace one relay serves. One community = one TOON relay + its fronting connector, operated by the community's operator.
_Avoid_: workspace-server, tenant

**Paid write**:
Any event published through the community's connector; each spends a payment-channel claim. Writes are paid, reads are free — this replaces write-gating auth.
_Avoid_: post (for the payment concept)

**Encrypted group**:
A private channel whose content is NIP-44-encrypted with its channel key. Privacy is cryptographic, never relay-enforced — the relay serves everyone.
_Avoid_: private channel ACL, protected channel

**Channel key**:
The shared symmetric key encrypting one channel's content and media. Possession of the current channel key IS membership.

**Admin list**:
The signed, replaceable channel-metadata event naming who may distribute the channel key and trigger rotation. The creator is the first admin; clients trust its signature chain, not the relay.

**Rotation**:
Issuing a new channel key and re-wrapping it to remaining members when someone is removed. Removed members keep what they already had; they lose what comes next.

**Agent-member**:
An agent participating as a member with its own keys — including channel keys. Infrastructure is agent-members too: the search indexer and workflow runner hold keys like any teammate and pay for their writes.
_Avoid_: bot, service account

**Store node**:
TOON's Arweave blob node fronted by a connector; the media path. Content on it is public and permanent.
_Avoid_: Blossom, DVM, ario node

**Tombstone**:
The only form of delete: an event marking content withdrawn. The bytes on the store node persist forever.
_Avoid_: delete (unqualified)

**Relay-native huddle**:
Live audio as dust-priced ephemeral paid frames published over BTP, with listeners on free relay subscriptions. There is no media server. Target design of ADR 0003, now superseded — see ADR 0008; live huddle audio runs on the admission+room relay until multi-speaker aggregate load is re-validated.
_Avoid_: room service, SFU, media server

**Pay-for-what-persists**:
The pricing principle: stored events cost money; unstored ephemeral traffic rides a free lane (relay#129, toon-meta#393 epic E2).

**Ephemeral chatter**:
Presence, typing indicators, and similar unstored kind-20000–29999 noise. Dropped in v1; rides the free ephemeral lane as of toon-meta#393 epic E3 (buzz#213).

**Onboarding wizard**:
The identity → funding → channel-open flow every new member (human or agent) completes before their first paid write.

**Sidecar**:
The local `toon-clientd` daemon that owns keys, channels, and payments for non-TypeScript writers (CLI, ACP agents).

**Transport seam**:
The narrow interface where buzz code hands a write to TOON (the embedded client or sidecar). Everything upstream of the seam stays cherry-pickable from `block/buzz`.
