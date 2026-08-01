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

`src/shared/api/relayEventTransport.ts` is the only implementation today: the
NIP-42 relay session. A second transport is a second implementation of
`EventTransport` plus a `setEventTransport(...)` call — no call site changes.
`pnpm check:transport-seam` fails the build if a call site reaches past the
seam for the relay session's write verbs.

Two write surfaces are deliberately off the seam and documented in
`eventTransport.ts`: `readOnlyRelayClient.ts` (read-state published to an
explicitly passed *other* community's relay) and the Rust half of the app,
where Tauri commands build, sign, and POST their own events over NIP-98 HTTP.
The Rust surface has no single chokepoint yet and needs its own seam.
