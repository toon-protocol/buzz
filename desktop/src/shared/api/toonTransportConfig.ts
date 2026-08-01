/**
 * Where the TOON transport writes, reads, and pays — resolved from
 * configuration rather than compiled in.
 *
 * TOON is a *second* network, not a replacement: writes are paid packets to a
 * connector edge and reads are free subscriptions to a Nostr relay behind it.
 * Both endpoints, the ILP destination, and the settlement chain move
 * independently of a Buzz release (the devnet is redeployed far more often
 * than the app ships), so every one of them is a config key with a devnet
 * default rather than a constant.
 */

/** Which implementation of the transport seam carries the app's writes. */
export type TransportMode = "relay" | "toon";

/** A fully-resolved TOON transport configuration. */
export type ToonTransportConfig = {
  mode: TransportMode;
  /** ILP-over-HTTP endpoint of the connector edge that terminates writes. */
  proxyUrl: string;
  /** Nostr relay the free read subscriptions attach to. */
  relayUrl: string;
  /** ILP address of the publish route on that edge. */
  destination: string;
  /**
   * BIP-39 phrase the *payment* identity is derived from.
   *
   * Distinct from the Buzz signing identity, which stays in Rust and never
   * enters JS: the event is signed by the user, the packet is paid for by this
   * key. Null when unset, which makes {@link ToonTransportConfig} unusable for
   * writes — reads still work, since they are free.
   */
  mnemonic: string | null;
  /** BIP-44 account index within `mnemonic`. */
  accountIndex: number;
  /** Settlement chain key, e.g. `evm:84532` (Base Sepolia). */
  chain: string;
  /** RPC endpoint for `chain`, needed before a channel can be opened. */
  chainRpcUrl: string;
  /** TokenNetwork (payment-channel) contract on `chain`. */
  tokenNetwork: string;
  /** Settlement token (USDC) contract on `chain`. */
  preferredToken: string;
};

/**
 * The shared TOON devnet, as deployed today.
 *
 * `proxyUrl` is the Rust connector edge. It deliberately does NOT come from
 * the relay's kind:10032 announce: the official edge does not announce itself,
 * and the announce that does exist has been observed advertising a different
 * `httpEndpoint` than the one serving traffic. Discovery is an optimisation;
 * a tracer bullet wants the address that is known to answer.
 */
export const TOON_DEVNET_DEFAULTS = {
  proxyUrl: "https://proxy.devnet.toonprotocol.dev/rust/ilp",
  /**
   * Note `relay-ws`, not `relay`: `relay.devnet.toonprotocol.dev` resolves to
   * parked DNS and fails the TLS handshake.
   */
  relayUrl: "wss://relay-ws.devnet.toonprotocol.dev",
  destination: "g.toon.relay",
  chain: "evm:84532",
  chainRpcUrl: "https://base-sepolia-rpc.publicnode.com",
  tokenNetwork: "0x1E95493fEF46707E034b4a1945f25a8C76A1823D",
  preferredToken: "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce",
} as const;

/** The environment keys this module reads, so callers can forward exactly these. */
export const TOON_TRANSPORT_ENV_KEYS = [
  "BUZZ_TRANSPORT",
  "BUZZ_TOON_PROXY_URL",
  "BUZZ_TOON_RELAY_URL",
  "BUZZ_TOON_DESTINATION",
  "BUZZ_TOON_MNEMONIC",
  "BUZZ_TOON_ACCOUNT_INDEX",
  "BUZZ_TOON_CHAIN",
  "BUZZ_TOON_CHAIN_RPC_URL",
  "BUZZ_TOON_TOKEN_NETWORK",
  "BUZZ_TOON_PREFERRED_TOKEN",
] as const;

/** One value from the environment, with blanks treated as absent. */
export type ToonTransportEnv = Partial<
  Record<(typeof TOON_TRANSPORT_ENV_KEYS)[number], string | null | undefined>
>;

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * `relay` unless the environment explicitly asks for `toon`.
 *
 * Upstream parity is the reason for the asymmetry: an unrecognised or missing
 * value must land on the transport `block/buzz` also has, so a bad config
 * degrades to the app everyone else runs rather than to a broken one.
 */
export function parseTransportMode(value: string | null | undefined): {
  mode: TransportMode;
  unrecognised: string | null;
} {
  const normalised = text(value)?.toLowerCase() ?? null;
  if (normalised === null) return { mode: "relay", unrecognised: null };
  if (normalised === "toon") return { mode: "toon", unrecognised: null };
  if (normalised === "relay") return { mode: "relay", unrecognised: null };
  return { mode: "relay", unrecognised: normalised };
}

function accountIndexOf(value: string | null | undefined): number {
  const parsed = Number.parseInt(text(value) ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Resolve the transport configuration from an environment map. */
export function resolveToonTransportConfig(
  env: ToonTransportEnv,
): ToonTransportConfig {
  return {
    mode: parseTransportMode(env.BUZZ_TRANSPORT).mode,
    proxyUrl: text(env.BUZZ_TOON_PROXY_URL) ?? TOON_DEVNET_DEFAULTS.proxyUrl,
    relayUrl: text(env.BUZZ_TOON_RELAY_URL) ?? TOON_DEVNET_DEFAULTS.relayUrl,
    destination:
      text(env.BUZZ_TOON_DESTINATION) ?? TOON_DEVNET_DEFAULTS.destination,
    mnemonic: text(env.BUZZ_TOON_MNEMONIC),
    accountIndex: accountIndexOf(env.BUZZ_TOON_ACCOUNT_INDEX),
    chain: text(env.BUZZ_TOON_CHAIN) ?? TOON_DEVNET_DEFAULTS.chain,
    chainRpcUrl:
      text(env.BUZZ_TOON_CHAIN_RPC_URL) ?? TOON_DEVNET_DEFAULTS.chainRpcUrl,
    tokenNetwork:
      text(env.BUZZ_TOON_TOKEN_NETWORK) ?? TOON_DEVNET_DEFAULTS.tokenNetwork,
    preferredToken:
      text(env.BUZZ_TOON_PREFERRED_TOKEN) ??
      TOON_DEVNET_DEFAULTS.preferredToken,
  };
}

/**
 * Why this config cannot carry a paid write, or null when it can.
 *
 * Reads are free, so a mode-`toon` config missing its payment key is still
 * useful — it just cannot write. Callers report this rather than failing at
 * the first message the user sends.
 */
export function describeWriteBlocker(
  config: ToonTransportConfig,
): string | null {
  if (config.mnemonic === null) {
    return "BUZZ_TOON_MNEMONIC is unset — the TOON transport can read but not pay for writes.";
  }
  return null;
}

/** The chosen transport plus anything the operator should know about it. */
export type TransportSelection = {
  mode: TransportMode;
  config: ToonTransportConfig;
  /** Non-fatal problems worth logging: unusable config, unknown mode value. */
  warnings: string[];
};

/**
 * Decide the transport from an environment map, without installing anything.
 *
 * Pure, so the precedence rules — a synchronous dev override beats the runtime
 * environment, an unknown value falls back to the relay — are testable without
 * a Tauri host.
 */
export function decideTransport(
  env: ToonTransportEnv,
  devOverride: string | null = null,
): TransportSelection {
  const warnings: string[] = [];
  const requested = devOverride ?? env.BUZZ_TRANSPORT ?? null;
  const { mode, unrecognised } = parseTransportMode(requested);

  if (unrecognised !== null) {
    warnings.push(
      `Unknown BUZZ_TRANSPORT value "${unrecognised}" — falling back to the relay transport.`,
    );
  }

  const config = { ...resolveToonTransportConfig(env), mode };

  if (mode === "toon") {
    const blocker = describeWriteBlocker(config);
    if (blocker !== null) warnings.push(blocker);
  }

  return { mode, config, warnings };
}
