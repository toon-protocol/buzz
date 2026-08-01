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
