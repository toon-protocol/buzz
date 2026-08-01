# Buzz

Desktop chat shell with:

- Tauri + React + TypeScript + Vite
- Tailwind CSS
- shadcn/ui-ready shared components
- Biome (lint/format/check)
- Feature-driven frontend structure

## Scripts

- `pnpm dev` - run the web frontend
- `pnpm tauri dev` - run the desktop app
- `pnpm build` - typecheck and build frontend
- `pnpm typecheck` - TypeScript checks
- `pnpm lint` - Biome lint
- `pnpm format` - Biome format (write)
- `pnpm check` - Biome check

## Structure

- `src/shared` - reusable app-wide code (`ui`, `lib`, `styles`)
- `src/features` - feature modules (vertical slices)
- `src/app` - top-level app composition

## Transport seam

Every event the app writes leaves through one interface, `EventTransport` in
`src/shared/api/eventTransport.ts`. Call sites never publish through a relay
client; they call the seam's free functions (`publishEvent`,
`publishEphemeralEvent`, `ensureTransportReady`, `isTransportWritable`) or one
of the buzz write verbs in `src/shared/api/eventWrites.ts`, which build and
sign an event and then hand it to the seam.

The seam also carries live reads (`subscribeLive`). A transport that writes
somewhere the app cannot read from is a dead letter box, so the tail of a
channel moves with the writes. History paging does not: `channelWindow.ts`
still asks buzz-relay's REST window, which server-assembles thread summaries
and aux overlays a plain NIP-01 REQ cannot reproduce.

There are two implementations. `src/shared/api/relayEventTransport.ts` is the
NIP-42 relay session and the default. `src/shared/api/toonEventTransport.ts`
is the TOON transport (below). A third is a third implementation of
`EventTransport` plus a `setEventTransport(...)` call — no call site changes.
`pnpm check:transport-seam` fails the build if a call site reaches past the
seam for the relay session's seamed verbs.

### The TOON transport

TOON is pay-to-write Nostr over Interledger: a write is an ILP packet carrying
a payment-channel claim, and reads are free relay subscriptions.
`ToonEventTransport` splits along that line — `toonPaidWriter.ts` pays through
a connector edge, `toonRelayReader.ts` subscribes to the relay behind it.

Select it with `BUZZ_TRANSPORT=toon`. **The relay transport is the default and
stays the default**: Buzz tracks `block/buzz` upstream, and a hard swap would
make every cherry-pick a conflict. An unset or unrecognised value lands on the
relay.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUZZ_TRANSPORT` | `relay` | `relay` or `toon` |
| `BUZZ_TOON_MNEMONIC` | — | BIP-39 phrase the *payment* identity derives from. Without it TOON can read but not write |
| `BUZZ_TOON_ACCOUNT_INDEX` | `0` | BIP-44 account index within the phrase |
| `BUZZ_TOON_PROXY_URL` | `https://proxy.devnet.toonprotocol.dev/rust/ilp` | ILP-over-HTTP endpoint of the connector edge |
| `BUZZ_TOON_RELAY_URL` | `wss://relay-ws.devnet.toonprotocol.dev` | Relay the free read subscriptions attach to |
| `BUZZ_TOON_DESTINATION` | `g.toon.relay` | ILP address of the publish route |
| `BUZZ_TOON_CHAIN` | `evm:84532` | Settlement chain (Base Sepolia) |
| `BUZZ_TOON_CHAIN_RPC_URL` | Base Sepolia public RPC | RPC for that chain — **required**, the client opens no channel without it |
| `BUZZ_TOON_TOKEN_NETWORK` | devnet TokenNetwork | Payment-channel contract |
| `BUZZ_TOON_PREFERRED_TOKEN` | devnet USDC | Settlement token |

The values are read at runtime through the `get_transport_env` Tauri command
(`src-tauri/src/transport.rs`), not from `import.meta.env`, so a shipped build
can be pointed at a devnet. `VITE_BUZZ_TRANSPORT` is honoured first as a
synchronous dev override for `pnpm dev` and Playwright.

The payment identity needs the settlement token **and native gas** on
`BUZZ_TOON_CHAIN` — opening the channel is an on-chain transaction.
`https://faucet.devnet.toonprotocol.dev` dispenses both.

What the TOON transport does not carry yet:

- **Ephemeral writes are dropped.** Paying a per-packet fee for a typing
  indicator is not a tradeoff worth making silently.
- **The Rust write path.** Threaded replies, media, and custom-emoji messages
  are built and POSTed from `src-tauri` and never reach this seam, so on TOON
  they go nowhere. A plaintext top-level message is what round-trips today.
- **History paging**, as above.

Live devnet proof (opt-in, spends test-network money):

```sh
BUZZ_TOON_LIVE=1 BUZZ_TOON_MNEMONIC="…" pnpm test
```

`src/shared/api/toonDevnetRoundTrip.live.test.mjs` pays a `kind:9` channel
message onto the devnet and asserts two independent free subscribers see it.
It is skipped without those variables.

Two write surfaces are deliberately off the seam and documented in
`eventTransport.ts`: `readOnlyRelayClient.ts` (read-state published to an
explicitly passed *other* community's relay) and the Rust half of the app,
where Tauri commands build, sign, and POST their own events over NIP-98 HTTP.
The Rust surface has no single chokepoint yet and needs its own seam.

### Encrypted channels

A private channel on TOON is not a channel the relay withholds — the relay
serves everyone. It is a channel whose content is NIP-44 v2 encrypted with a
**channel key** every member holds (ADR 0001, ADR 0002). Possession of the key
is membership.

**Encryption sits above the transport seam, never inside a transport.** A
message is sealed in `shared/api/eventWrites.ts` before `signRelayEvent` —
content sealed after signing is content the signature no longer covers — and
opened where events enter the app: `subscribeLiveEvents` in
`shared/api/eventTransport.ts` for the live tail, `getChannelWindowEvents` in
`shared/api/channelWindow.ts` for history. Both are the transport-agnostic
facade, so a channel is encrypted identically on the relay transport and on
TOON, and a third transport inherits it without implementing anything.

| File | Role |
| --- | --- |
| `shared/api/channelEncryption.ts` | NIP-44 v2 primitives, key parsing/format, key ids |
| `shared/api/channelKeyStore.ts` | Which keys this client holds, across restarts |
| `shared/api/channelMessageCrypto.ts` | Event-level seal/open and the wire layout |
| `shared/api/channelAdminList.ts` | The signed admin list: build, parse, validate the chain |
| `shared/api/channelAdminListStore.ts` | Admin lists this client has seen, and their resolved state |
| `shared/api/channelKeyDelivery.ts` | NIP-59 gift wrap / unwrap of a channel key |
| `shared/api/channelMembership.ts` | The write verbs: publish the admin list, hand out the key |
| `shared/api/channelKeyInbox.ts` | Watches for wraps and unlocks channels |
| `features/channels/ui/ChannelEncryptionSettings.tsx` | The admin list, and the manual paste-the-key field |

On the wire an encrypted message is an ordinary `kind:9` with its
`["h", <channelId>]` tag — nothing about routing, reading, or paying grows a
second case. What changes is `content`, which becomes a NIP-44 v2 payload, plus
one marker tag:

```
["encrypted", "nip44-v2", "<keyId>"]
```

`keyId` is a truncated domain-separated hash of the key, not the key. It exists
so a client holding more than one key for a channel — what rotation produces —
can choose without trial decryption.

Tags stay in the clear: the channel id because a client needs it to pick a key
at all, and `p` mention tags so a mentioned member is notified without every
client decrypting every message. That last one is a real leak (an observer
learns who was addressed) and is taken knowingly.

#### Membership authority and key delivery

Creating a **private** channel generates its key and publishes a signed,
addressable admin list naming the creator as its first admin:

```
kind:39100   ["d", <channelId>]
             ["creator", <creatorPubkey>]
             ["p", <pubkey>, "admin"]   (one per admin, creator first)
             ["key", <keyId>, <epoch>]
```

Deliberately **not** NIP-29's `kind:39001`, which carries the same shape but is
*relay*-signed — ADR 0001 says the relay is never the membership authority.
Addressability alone proves nothing either (anyone can publish a 39100 with any
`d` tag), so `channelAdminList.resolveChannelAdminList` folds every candidate in
`created_at` order and accepts a change only from a signer who was an admin in
the state before it, rooted at a genesis event that names itself. The relay can
drop or reorder events; the worst it can produce is a stale list.

Adding a member gift-wraps the channel key to them (NIP-59: a `kind:1059` wrap
around a `kind:13` seal around a `kind:44300` rumor). The recipient's client
subscribes to wraps tagged with its own pubkey, unwraps, checks the **seal's**
signer against the validated admin list, and calls `setChannelKey` — the
channel unlocks and its history decrypts with no further action. A wrap from a
non-admin is refused; a wrap that arrives before the channel's admin list is
held until it does.

Both are ordinary writes through the transport seam, so on TOON both are paid:
one claim for the admin list, one per recipient for the wraps.

**The manual paste field stays** as the recovery path — channels created before
this feature have no admin list, a failed paid write sends nothing, and a
client whose keyring was locked at launch never started its inbox. For scripted
or two-box setups there is an environment variable:

| Variable | Meaning |
| --- | --- |
| `BUZZ_CHANNEL_KEYS` | `channelId=hexkey` pairs, comma- or newline-separated. Overrides stored keys |

Keys persist in `localStorage` under `buzz-channel-keys.v1`, which is the
honest statement of the threat model: this protects a channel from the relay
and from non-members, not from someone with the user's disk.

What is not encrypted yet:

- **The Rust write path.** Threaded replies, media, and custom-emoji messages
  are built and POSTed from `src-tauri`, never reach the seam, and therefore go
  out in the clear even in a keyed channel.
- **Media.** ADR 0002 puts private-channel blobs under the same channel key
  before upload; the upload path is not on this yet.
- **Search and the local archive**, which index whatever content reaches them —
  plaintext for members, placeholders for everyone else.

What key management does not do yet:

- **Rotation on removal** (buzz#18). Removing a member takes their roster row
  away and leaves them holding a working key. The admin list already carries
  the `keyId` and `epoch` a rotation would bump, and the chain refuses an epoch
  that moves backwards, so the wire format is ready and the act is not.
- **Unwrapping in Rust.** The renderer reads the user's secret key over
  `get_nsec` to do the two NIP-44 layers (`shared/api/identitySecretKey.ts` —
  the single exception to "the key stays in Rust"). A `sign_event`-style
  seal/unseal command pair would close it.
