import { buildToonClientOptions } from "@/shared/api/toonPaidWriter";
import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";

/**
 * Fund + open-channel orchestration for provisioning a managed agent's TOON
 * wallet as one action (buzz#74): derive the agent's address from the
 * owner's mnemonic at its Rust-assigned account index (buzz#79), send it
 * native gas + settlement token from the owner's own wallet, then open the
 * agent's own payment channel with an initial allowance.
 *
 * Deliberately a distinct client seam from `toonPaidWriter.ts`'s
 * `PaidClient`: provisioning never signs a claim or publishes an event, only
 * moves capital (`sendTransfer`) and opens a channel (`openChannel`) — a
 * narrower surface than the writer needs, and one that never touches
 * `getActiveToonTransport()`'s singleton writer (see `buildToonClientOptions`'s
 * doc comment), since a provisioning client is never the owner's or an
 * agent's *running* transport, only a short-lived one used once here.
 */

export type TransferChain = "evm" | "solana" | "mina";

/** What `ToonClient.sendTransfer` returns once the destination's balance delta was observed. */
export type SendTransferResult = {
  txHash: string;
  balanceBefore: string;
  balanceAfter: string;
};

/** The subset of `ToonClient` this module drives. */
export type ProvisioningClient = {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  /**
   * `ToonClient.sendTransfer` (toon-client#491) already confirms delivery by
   * an OBSERVED balance delta at the destination before resolving — throwing
   * `TransferNotDeliveredError` rather than resolving on a send that landed
   * on-chain but delivered nothing (the devnet faucet's Solana leg has done
   * exactly that, connector#691). This module does not re-verify the delta
   * itself; it relies on that guarantee.
   */
  sendTransfer(params: {
    chain: TransferChain;
    asset: "native" | "token";
    to: string;
    amount: string | bigint;
  }): Promise<SendTransferResult>;
  /** Open (or reuse, per-peer idempotent) a payment channel for `destination`. */
  openChannel(destination?: string): Promise<string>;
  /** The flat per-packet route price, when sizing the fund step's allowance from a live quote rather than the fallback. */
  getRoutePrice?(destination: string): Promise<bigint | null>;
};

export type ProvisioningClientFactory = (
  config: ToonTransportConfig,
  accountIndex: number,
  initialDeposit?: string | null,
) => Promise<ProvisioningClient>;

/** Thrown when provisioning cannot proceed — never for a single funding leg's failure, see {@link FundLegResult}. */
export class AgentProvisioningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentProvisioningError";
  }
}

const createProvisioningClient: ProvisioningClientFactory = async (
  config,
  accountIndex,
  initialDeposit,
) => {
  const [options, { ToonClient }] = await Promise.all([
    buildToonClientOptions(config, accountIndex, initialDeposit ?? undefined),
    import("@toon-protocol/client"),
  ]);
  return new ToonClient(options as never) as unknown as ProvisioningClient;
};

/** The EVM address `mnemonic` derives to at `accountIndex` — pure, local, offline. */
export async function deriveAgentAddress(
  mnemonic: string,
  accountIndex: number,
): Promise<string> {
  const { deriveFullIdentity } = await import("@toon-protocol/client");
  const identity = await deriveFullIdentity(mnemonic, accountIndex);
  return identity.evm.address;
}

/** The owner's own client (account index 0), used to fund an agent's address. */
export async function buildOwnerProvisioningClient(
  config: ToonTransportConfig,
  factory: ProvisioningClientFactory = createProvisioningClient,
): Promise<ProvisioningClient> {
  if (config.mnemonic === null) {
    throw new AgentProvisioningError(
      "No owner payment mnemonic configured — cannot fund an agent's wallet.",
    );
  }
  const client = await factory(config, config.accountIndex, null);
  await client.start();
  return client;
}

/** A short-lived client at the agent's own account index, used once to open its channel. */
export async function buildAgentProvisioningClient(
  config: ToonTransportConfig,
  accountIndex: number,
  initialDepositBaseUnits: bigint,
  factory: ProvisioningClientFactory = createProvisioningClient,
): Promise<ProvisioningClient> {
  if (config.mnemonic === null) {
    throw new AgentProvisioningError(
      "No owner payment mnemonic configured — cannot open the agent's channel.",
    );
  }
  return factory(config, accountIndex, initialDepositBaseUnits.toString());
}

/** One funding leg's outcome — never thrown, so a caller can show "gas failed, USDC landed" rather than losing the successful leg to a rejected promise. */
export type FundLegResult =
  | { status: "ok"; result: SendTransferResult }
  | { status: "error"; message: string };

async function attemptTransfer(
  client: ProvisioningClient,
  params: {
    chain: TransferChain;
    asset: "native" | "token";
    to: string;
    amount: bigint;
  },
): Promise<FundLegResult> {
  try {
    const result = await client.sendTransfer(params);
    return { status: "ok", result };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fund `agentAddress` with native gas and the settlement token from the
 * owner's own (already-started) client. The two legs run independently and
 * neither can fail the other — `agentProvisioningState.ts`'s fund step
 * already treats "token landed, gas didn't" (and the reverse) as a legitimate
 * resumable state, so surfacing a partial result here (rather than throwing
 * on the first rejection) is what makes that resumability possible.
 */
export async function fundAgentWallet(params: {
  ownerClient: ProvisioningClient;
  agentAddress: string;
  chain: TransferChain;
  nativeAmountBaseUnits: bigint;
  tokenAmountBaseUnits: bigint;
}): Promise<{ native: FundLegResult; token: FundLegResult }> {
  const [native, token] = await Promise.all([
    attemptTransfer(params.ownerClient, {
      chain: params.chain,
      asset: "native",
      to: params.agentAddress,
      amount: params.nativeAmountBaseUnits,
    }),
    attemptTransfer(params.ownerClient, {
      chain: params.chain,
      asset: "token",
      to: params.agentAddress,
      amount: params.tokenAmountBaseUnits,
    }),
  ]);
  return { native, token };
}

/**
 * Open the agent's own payment channel against `destination`, using a
 * client scoped to the agent's own account index (never the owner's) — the
 * channel's collateral and signing identity belong to the agent. The client
 * is started and stopped around the single call: nothing here keeps it
 * alive for future writes, since the agent's own runtime (once spawned)
 * tracks and resumes this channel independently.
 */
export async function openAgentChannel(params: {
  agentClient: ProvisioningClient;
  destination: string;
}): Promise<string> {
  await params.agentClient.start();
  try {
    return await params.agentClient.openChannel(params.destination);
  } finally {
    await params.agentClient.stop();
  }
}
