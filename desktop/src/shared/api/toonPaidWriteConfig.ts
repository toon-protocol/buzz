import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";

/**
 * The configuration half of the paid writer (split out of
 * `toonPaidWriter.ts` for its size budget): how a `ToonClient` is
 * parameterized — endpoint fields, identity/settlement bootstrap — plus the
 * error type and settlement constants every paid-write surface shares.
 * `ToonPaidWriter` re-exports this module's public surface, so callers keep
 * one import home.
 */

/** TOON settles in USDC on every chain the devnet offers. */
export const SETTLEMENT_ASSET = "USDC";
export const SETTLEMENT_ASSET_SCALE = 6;

/** Thrown when a paid write cannot be attempted or the packet was refused. */
export class ToonPaidWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToonPaidWriteError";
  }
}

/**
 * The endpoint fields handed to the `ToonClient` constructor — the seam that
 * decides which wire paid writes ride (buzz#23 stage 2).
 *
 * With `btpUrl` set (the default), the client gets `{connectorUrl, btpUrl,
 * btpAuthToken: ""}` and runs every paid write over the connector's ordered
 * BTP session. With `btpUrl: null` (`BUZZ_TOON_BTP_URL=off`), it gets
 * `{proxyUrl}` instead, which forces the client's stateless one-shot
 * ILP-over-HTTP transport. The two are mutually exclusive by construction:
 * the client prefers the HTTP transport whenever a `proxyUrl` is present, so
 * passing both would silently cap paid writes at the HTTP path's measured
 * ~16 accepted writes/sec — not viable for 50 fps huddle audio (ADR 0003).
 */
export function transportEndpointFields(
  config: Pick<ToonTransportConfig, "connectorUrl" | "btpUrl" | "proxyUrl">,
):
  | { connectorUrl: string; btpUrl: string; btpAuthToken: string }
  | { proxyUrl: string } {
  return config.btpUrl !== null
    ? {
        connectorUrl: config.connectorUrl,
        btpUrl: config.btpUrl,
        btpAuthToken: "",
      }
    : { proxyUrl: config.proxyUrl };
}

/**
 * The `ToonClient` constructor options for `config` at `accountIndex` — the
 * identity/settlement bootstrap every `ToonClient` this app builds shares,
 * whether it is this writer's own client or one of buzz#74's provisioning
 * clients (`provisionAgent.ts`'s owner-scoped client for `sendTransfer`, and
 * agent-scoped client for `openChannel`), which need a different account
 * index and initial deposit but nothing else about the bootstrap.
 *
 * `supportedChains` and `chainRpcUrls` are both load-bearing and easy to
 * mistake for optional: the client only constructs an on-chain channel client
 * when `chainRpcUrls` is set, and without one the first write dies with "No
 * channel client configured" *after* the user has already sent a message.
 *
 * The transport is decided here too, by which endpoint fields are passed
 * (buzz#23 stage 2): with `btpUrl` set — the default — the client gets
 * `{connectorUrl, btpUrl, btpAuthToken: ""}` and runs every paid write over
 * the connector's ordered BTP session; setting `proxyUrl` instead would force
 * the client's stateless one-shot ILP-over-HTTP transport, measured at
 * ~16 accepted writes/sec on the devnet edge — fine for chat, not viable for
 * 50 fps huddle audio. There is deliberately no parallel path: BTP carries
 * *all* paid writes, or (with `BUZZ_TOON_BTP_URL=off`) HTTP carries all of
 * them. The exact BTP config shape is the one proven live by the huddle
 * prototype (toon-meta `proto/huddle-multi-speaker`, `multi.mjs`).
 */
export async function buildToonClientOptions(
  config: Pick<
    ToonTransportConfig,
    | "mnemonic"
    | "connectorUrl"
    | "btpUrl"
    | "proxyUrl"
    | "relayUrl"
    | "destination"
    | "chain"
    | "chainRpcUrl"
    | "tokenNetwork"
    | "preferredToken"
  >,
  accountIndex: number,
  initialDeposit?: string | null,
): Promise<Record<string, unknown>> {
  if (config.mnemonic === null) {
    throw new ToonPaidWriteError(
      "No TOON payment identity configured (BUZZ_TOON_MNEMONIC).",
    );
  }

  const { encodeEventToToon, decodeEventFromToon } = await import(
    "@toon-protocol/core"
  );

  return {
    mnemonic: config.mnemonic,
    mnemonicAccountIndex: accountIndex,
    ...transportEndpointFields(config),
    relayUrl: config.relayUrl,
    destinationAddress: config.destination,
    ilpInfo: {
      pubkey: "00".repeat(32),
      ilpAddress: "g.toon.client",
      btpEndpoint: config.btpUrl ?? "",
      assetCode: SETTLEMENT_ASSET,
      assetScale: SETTLEMENT_ASSET_SCALE,
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    supportedChains: [config.chain],
    chainRpcUrls: { [config.chain]: config.chainRpcUrl },
    tokenNetworks: { [config.chain]: config.tokenNetwork },
    preferredTokens: { [config.chain]: config.preferredToken },
    // Collateral for a fresh channel open. The client's own default (0.1
    // USDC) is exhausted by ~2 seconds of huddle audio; see the config field.
    ...(initialDeposit != null ? { initialDeposit } : {}),
  };
}
