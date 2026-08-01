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
| `BUZZ_TOON_FAUCET_URL` | `https://faucet.devnet.toonprotocol.dev` | Devnet faucet the onboarding wizard's fund step posts to |

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

### Onboarding wizard

On `BUZZ_TRANSPORT=toon` with no `BUZZ_TOON_MNEMONIC` set, a fresh install has
no payment identity — reads work, writes cannot. `ToonOnboardingGate`
overlays the app until the self-serve path completes: generate (or import) a
payment identity → fund it from the devnet faucet → open a payment channel,
collateral shown before consent → send a first paid message in a public
channel, its fee shown before send.

The wizard is off entirely on the relay transport (there is nothing to pay
for) and re-entrant: quitting and relaunching mid-flow resumes at whichever
step reality says is next, rather than replaying a step counter. Identity and
funding are read straight from the wallet (a stored mnemonic, an on-chain
balance); channel-open and first-message are recorded as flags once their own
consented action succeeds, since checking either without one would mean
performing the very action the flag exists to gate. See
`toonOnboardingState.ts` for the derivation and why.

| File | Role |
| --- | --- |
| `features/onboarding/toon/toonOnboardingState.ts` | Pure step derivation from a reality snapshot |
| `features/onboarding/toon/toonOnboardingStore.ts` | The stored mnemonic + channel/first-message flags, across restarts |
| `features/onboarding/toon/toonOnboardingIdentity.ts` | Mnemonic generation/validation, address derivation |
| `features/onboarding/toon/toonOnboardingBalances.ts` | Free wallet-balance reads for the fund step |
| `features/onboarding/toon/toonFaucetClient.ts` | The faucet POST, with 429-cooldown and timeout handling |
| `features/onboarding/toon/toonOnboardingFormat.ts` | USDC amount formatting + the default channel-open collateral estimate |
| `features/onboarding/toon/useToonOnboarding.ts` | The hook wiring the above to the gate UI |
| `features/onboarding/ui/ToonOnboardingGate.tsx` | The wizard screen |

A generated identity is stored the same way a pasted channel key is
(`localStorage`, see Encrypted channels below) — env still wins so a scripted
or two-box setup can override it, but a human with nothing but the app now
gets one without ever touching an environment variable.

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
| `shared/api/channelKeyStore.ts` | Which keys this client holds, across restarts — a ring per channel |
| `shared/api/channelMessageCrypto.ts` | Event-level seal/open and the wire layout |
| `shared/api/channelAdminList.ts` | The signed admin list: build, parse, validate the chain |
| `shared/api/channelAdminListStore.ts` | Admin lists this client has seen, and their resolved state |
| `shared/api/channelKeyDelivery.ts` | NIP-59 gift wrap / unwrap of a channel key |
| `shared/api/channelMembership.ts` | The write verbs: publish the admin list, announce the key epoch, hand out the key |
| `shared/api/channelKeyInbox.ts` | Watches for wraps and unlocks channels |
| `shared/api/channelKeyRotation.ts` | Rotation on removal: new key, wraps to survivors, new epoch |
| `shared/api/channelKeyEpoch.ts` | Which held key a channel sends with, decided by its admin list |
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

Creating a **private** channel publishes a signed, addressable admin list
naming the creator as its first admin:

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

It does **not** mint a key. Encryption stays switched on by the presence of a
key and nothing else; auto-keying every private channel would move that switch
onto the visibility flag and decide, from a checkbox meaning "not listed
publicly", that the channel's whole history is unreadable to anyone without the
bytes. Keying remains an act the user takes in channel settings; doing it
republishes the admin list with the new `keyId` so members know which epoch is
current.

Adding a member gift-wraps the channel key to them (NIP-59: a `kind:1059` wrap
around a `kind:13` seal around a `kind:44300` rumor). The recipient's client
subscribes to wraps tagged with its own pubkey, unwraps, checks the **seal's**
signer against the validated admin list, and calls `setChannelKey` — the
channel unlocks and its history decrypts with no further action. A wrap from a
non-admin is refused; a wrap that arrives before the channel's admin list is
held until it does.

Both are ordinary writes through the transport seam, so on TOON both are paid:
one claim for the admin list, one per recipient for the wraps.

#### Rotation on removal (buzz#18)

Removing someone from an encrypted channel is not a roster edit. Membership IS
key possession, so a removal that leaves the key alone removes nothing.
`channelKeyRotation.rotateChannelKeyForRemoval` is the actual removal, and it
publishes in a fixed order:

```
1. gift-wrap a fresh key to every REMAINING member        (N paid writes)
2. publish the admin list: epoch + 1, new keyId, member gone   (1 write)
3. only then switch this client's sending key
```

**Wraps first**, because a recipient validates a wrap against the admin list
*they* currently hold — the pre-rotation one, in which the sender is still an
admin. Publishing the list first would open a window where the channel names an
epoch whose key nobody has been sent, which every survivor reads as "I have been
removed".

**Sending switches last**, and receivers never have to switch at all: every
sealed message names its key id, and a survivor's ring opens both epochs. So the
only order that can hurt is sealing under a key the channel has not announced,
and that is the one this rule forbids. Nothing is ever written in the clear —
the old key stays the sending key right up to the swap.

A survivor's client makes the same move from the other side.
`channelKeyInbox.ts` adopts an arriving key into the ring **for reading only**,
and `channelKeyEpoch.ts` promotes it to the sending position when the validated
admin list names its `keyId`. The two events can land in either order; whichever
is second triggers the promotion.

Removing an admin is the same call — the new list simply omits them, so the
demotion and the epoch bump are one signed event and no client observes half of
it. The channel's *creator* is the exception: the chain is rooted in them, so
removing them rotates the key (they lose the content like anyone else) while
their name stays on the list. Re-rooting a channel is a different feature.

**The removed member keeps their history.** They hold the old key and everything
sealed under it stays readable to them forever — ADR 0001's Slack-export
semantics, and the only honest position against an open relay where they could
have archived every ciphertext already. Rotation protects the future.

Failure is partial, never silent. Wraps that do not land are reported per
recipient and leave the channel on its old epoch; a list that does not publish
leaves this client sending under a key the others hold but have not promoted, so
everyone still reads everyone. Removing anyone else rotates again.

**The manual paste field stays** as the recovery path — channels created before
this feature have no admin list, a failed paid write sends nothing, and a
client whose keyring was locked at launch never started its inbox. For scripted
or two-box setups there is an environment variable:

| Variable | Meaning |
| --- | --- |
| `BUZZ_CHANNEL_KEYS` | `channelId=hexkey` pairs, comma- or newline-separated. Overrides stored keys |

Keys persist in `localStorage` under `buzz-channel-keys.v2`, which is the
honest statement of the threat model: this protects a channel from the relay
and from non-members, not from someone with the user's disk. The record is
`{ version: 2, channels: { <channelId>: [<hexKey>, ...] } }` — **index 0 is the
key the channel sends with**, the rest are held so history from earlier epochs
still opens. A pre-#18 `buzz-channel-keys.v1` record (one key per channel) is
migrated to one-key rings on first read and then deleted; keeping it would leave
a copy of every key that "Forget key" and rotation both promise to have moved
on from. Rings are capped at 16 epochs.

Rust holds one key per channel (`src-tauri/src/channel_keys.rs`) and only ever
seals, so `channelKeySync.ts` pushes the *sending* key of each channel and
nothing else. `sync_channel_keys` replaces rather than merges, so a rotation
reaches the Rust write path as an ordinary re-sync — no new command, and the
superseded key is gone from that side the moment the ring's front moves.

What is not encrypted yet:

- **Media.** ADR 0002 puts private-channel blobs under the same channel key
  before upload; the upload path is not on this yet.
- **Search and the local archive**, which index whatever content reaches them —
  plaintext for members, placeholders for everyone else.

What key management does not do yet:

- **Rotation on anything but removal.** Leaving a channel voluntarily, and a
  key an admin believes has leaked, both still need the removal path run by
  hand. There is no scheduled or periodic rotation.
- **Re-rooting a channel**, so its creator can be removed from the admin list
  rather than only from its content.
- **Unwrapping in Rust.** The renderer reads the user's secret key over
  `get_nsec` to do the two NIP-44 layers (`shared/api/identitySecretKey.ts` —
  the single exception to "the key stays in Rust"). A `sign_event`-style
  seal/unseal command pair would close it.
