import type {
  ClaimStateRequestEntry,
  ClaimStateResult,
} from "@toon-protocol/client";

import { splitClaimStateWatermark } from "@/features/profile/lib/claimStateWatermark";
import type { RawNetworkFlowStatus } from "@/shared/api/toonPaidWriter";
import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";

/**
 * Per-agent, no-daemon claim-state reads (buzz#109, `docs/adr/0007`).
 *
 * Every agent's TOON payment key derives from the *owner's* seed (ADR 0006)
 * — the desktop already holds that seed from onboarding, so it can prove
 * control of ANY managed agent's channel itself, without that agent's
 * `buzz-acp` process or `toon-clientd` sidecar running (ADR 0005 governs how
 * an agent PAYS and is unchanged; this module only READS). This is what
 * lets a runway badge stay truthful for an agent that has already run out
 * and stopped — a read routed through the agent's own daemon would go dark
 * at exactly the moment the number matters.
 *
 * Two things this module does that `toonPaidWriter.ts`'s self-only
 * `getNetworkFlowStatus` cannot:
 *
 * 1. **Discover the channel.** The desktop cannot compute a channel id —
 *    `TokenNetwork.openChannel` derives it from a contract-global counter,
 *    not from the participants — and must not depend on the agent's own
 *    daemon-local resume store (that would reintroduce the daemon
 *    dependency this module exists to avoid, and would fail for an agent
 *    that has never run on this host). {@link findAgentEvmChannelId} scans
 *    `ChannelOpened` logs for the agent's derived address instead — the same
 *    approach ADR 0006's registry-loss recovery runbook already assumes.
 * 2. **Ask for N identities in one request.** `ToonClient.getClaimState` is
 *    single-identity by construction (it signs with the one instance's own
 *    key). `ConnectorEdgeClient.getClaimState` takes a list of independently
 *    signed entries, so {@link readAgentsNetworkFlowStatus} batches every
 *    agent's challenge into one `POST /ilp/claim-state` request.
 *
 * **EVM only.** Solana channels are accounts, discovered differently
 * (`SolanaSigner.signClaimStateChallenge` exists for when that lands) — an
 * agent on a non-EVM `chain` reads `unavailable` here, never a fabricated
 * zero.
 */

export type AgentAccountRef = { pubkey: string; accountIndex: number };

/**
 * `keccak256("ChannelOpened(bytes32,address,address,uint256)")` —
 * `TokenNetwork`'s channel-open event topic0. Hardcoded rather than computed
 * at runtime: the event signature is fixed, so recomputing it on every read
 * would only buy a keccak dependency this module otherwise has no reason to
 * carry. Verified against the ABI `@toon-protocol/client` bundles internally
 * for `OnChainChannelClient`'s own (private) channel-open log parsing.
 */
export const CHANNEL_OPENED_TOPIC =
  "0x448d27f1fe12f92a2070111296e68fd6ef0a01c0e05bf5819eda0dbcf267bf3d";

/** A signature the connector's `/ilp/claim-state` challenge stays valid for. Reissued fresh on every read — see `EvmSigner.signClaimStateChallenge`'s doc. */
const CLAIM_STATE_CHALLENGE_TTL_SECONDS = 60;

type EvmLog = { topics: string[]; blockNumber: string };

type EthGetLogsResponse =
  | { result: EvmLog[]; error?: undefined }
  | { error: { message?: string }; result?: undefined };

/** Left-pad a 20-byte address into a 32-byte topic, as `eth_getLogs` requires for an indexed `address` filter. */
function addressTopic(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "").padStart(40, "0");
  return `0x${"0".repeat(24)}${hex}`;
}

async function ethGetLogs(
  rpcUrl: string,
  params: { address: string; topics: (string | null)[] },
  fetchImpl: typeof fetch,
): Promise<EvmLog[]> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: params.address,
          topics: params.topics,
          fromBlock: "0x0",
          toBlock: "latest",
        },
      ],
    }),
  });
  const body = (await response.json()) as EthGetLogsResponse;
  if (body.error) {
    throw new Error(
      `eth_getLogs failed: ${body.error.message ?? "unknown error"}`,
    );
  }
  return body.result;
}

/**
 * Discover an agent's EVM payment channel by scanning `ChannelOpened` logs
 * for its derived address — see the module doc for why this is the only
 * daemon-free way to find it. `null` when no channel has ever opened with
 * this address on either side of the pair; the honest "no channel", never a
 * fabricated one.
 *
 * Two independent queries (one per indexed `participant` slot) rather than
 * one broad scan: `eth_getLogs`' topic filter ORs values WITHIN one
 * position but ANDs ACROSS positions, and `participant1`/`participant2` are
 * different positions, so "agent is participant1 OR participant2" needs two
 * requests, not one.
 */
export async function findAgentEvmChannelId(params: {
  rpcUrl: string;
  tokenNetworkAddress: string;
  agentAddress: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const topic = addressTopic(params.agentAddress);
  const [asParticipant1, asParticipant2] = await Promise.all([
    ethGetLogs(
      params.rpcUrl,
      {
        address: params.tokenNetworkAddress,
        topics: [CHANNEL_OPENED_TOPIC, null, topic],
      },
      fetchImpl,
    ),
    ethGetLogs(
      params.rpcUrl,
      {
        address: params.tokenNetworkAddress,
        topics: [CHANNEL_OPENED_TOPIC, null, null, topic],
      },
      fetchImpl,
    ),
  ]);
  const logs = [...asParticipant1, ...asParticipant2];
  if (logs.length === 0) return null;

  // Most-recently-opened wins if more than one channel was ever opened for
  // this address (e.g. a re-provisioned agent) — the current one is the
  // only one still worth reading.
  logs.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));
  return logs[0]?.topics[1] ?? null;
}

/** What `readAgentsNetworkFlowStatus` needs from a transport config — the protocol-level facts every agent shares (only the account index varies per agent). */
export type AgentClaimStateReadConfig = Pick<
  ToonTransportConfig,
  "mnemonic" | "chain" | "chainRpcUrl" | "tokenNetwork" | "connectorUrl"
>;

type EdgeClaimStateClient = {
  getClaimState(
    endpoint: string,
    entries: ClaimStateRequestEntry[],
  ): Promise<ClaimStateResult[]>;
};

export type AgentClaimStateReadDeps = {
  fetchImpl?: typeof fetch;
  /** Injectable so tests never construct a real `ConnectorEdgeClient` (or import `@toon-protocol/client` at all). */
  edgeClient?: EdgeClaimStateClient;
  /** Injectable identity/signing so tests never derive a real key. */
  deriveIdentity?: (
    mnemonic: string,
    accountIndex: number,
  ) => Promise<{ evm: { address: string; privateKey: Uint8Array } }>;
  signChallenge?: (
    privateKey: Uint8Array,
    params: {
      chainId: number;
      tokenNetworkAddress: string;
      channelId: string;
      expires: number;
    },
  ) => Promise<string>;
};

async function defaultDeriveIdentity(mnemonic: string, accountIndex: number) {
  const { deriveFullIdentity } = await import("@toon-protocol/client");
  return deriveFullIdentity(mnemonic, accountIndex);
}

async function defaultSignChallenge(
  privateKey: Uint8Array,
  params: {
    chainId: number;
    tokenNetworkAddress: string;
    channelId: string;
    expires: number;
  },
): Promise<string> {
  const { EvmSigner } = await import("@toon-protocol/client");
  return new EvmSigner(privateKey).signClaimStateChallenge(params);
}

async function defaultEdgeClient(): Promise<EdgeClaimStateClient> {
  const { ConnectorEdgeClient } = await import("@toon-protocol/client");
  return new ConnectorEdgeClient();
}

/** Parse the numeric chain id off `config.chain` (`"evm:84532"` / `"evm:base-sepolia:84532"`), or `null` for a non-EVM/malformed key. */
async function resolveEvmChainId(chain: string): Promise<number | null> {
  if (!chain.startsWith("evm:")) return null;
  const { parseEvmChainId } = await import("@toon-protocol/client");
  return parseEvmChainId(chain) ?? null;
}

/**
 * Read claim state for every agent in `agents` in ONE batched
 * `ConnectorEdgeClient.getClaimState` request — never one request per agent
 * (see the module doc's item 2). Every agent's identity is derived and its
 * channel discovered independently and in parallel; only the final connector
 * call is shared.
 *
 * Returns a map keyed by pubkey. An agent maps to `null` — never a
 * fabricated or stale-but-unlabelled figure — when: `config` has no
 * mnemonic, `config.chain` is not EVM (Solana is out of scope — see the
 * module doc), no channel was ever found for that agent's derived address,
 * or the connector could not verify that agent's challenge. A transport
 * failure reaching the connector itself throws (there is nothing honest to
 * report per-agent when the whole batch never got an answer).
 */
export async function readAgentsNetworkFlowStatus(
  config: AgentClaimStateReadConfig,
  agents: readonly AgentAccountRef[],
  deps: AgentClaimStateReadDeps = {},
): Promise<Map<string, RawNetworkFlowStatus | null>> {
  const results = new Map<string, RawNetworkFlowStatus | null>();
  if (agents.length === 0) return results;

  const chainId =
    config.mnemonic === null ? null : await resolveEvmChainId(config.chain);
  if (config.mnemonic === null || chainId === null) {
    for (const agent of agents) results.set(agent.pubkey, null);
    return results;
  }
  const mnemonic = config.mnemonic;

  const deriveIdentity = deps.deriveIdentity ?? defaultDeriveIdentity;
  const signChallenge = deps.signChallenge ?? defaultSignChallenge;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const expires =
    Math.floor(Date.now() / 1000) + CLAIM_STATE_CHALLENGE_TTL_SECONDS;

  const prepared = await Promise.all(
    agents.map(async (agent) => {
      const identity = await deriveIdentity(mnemonic, agent.accountIndex);
      const channelId = await findAgentEvmChannelId({
        rpcUrl: config.chainRpcUrl,
        tokenNetworkAddress: config.tokenNetwork,
        agentAddress: identity.evm.address,
        fetchImpl,
      });
      if (channelId === null) return { pubkey: agent.pubkey, channelId: null };
      const signature = await signChallenge(identity.evm.privateKey, {
        chainId,
        tokenNetworkAddress: config.tokenNetwork,
        channelId,
        expires,
      });
      return { pubkey: agent.pubkey, channelId, signature };
    }),
  );

  const readable = prepared.filter(
    (
      entry,
    ): entry is { pubkey: string; channelId: string; signature: string } =>
      entry.channelId !== null,
  );
  for (const entry of prepared) {
    if (entry.channelId === null) results.set(entry.pubkey, null);
  }
  if (readable.length === 0) return results;

  const edgeClient = deps.edgeClient ?? (await defaultEdgeClient());
  const claimResults = await edgeClient.getClaimState(
    config.connectorUrl,
    readable.map((entry) => ({
      blockchain: "evm" as const,
      channelId: entry.channelId,
      expires,
      signature: entry.signature,
    })),
  );

  readable.forEach((entry, index) => {
    const result = claimResults[index];
    const split = result?.ok
      ? splitClaimStateWatermark({
          depositTotal: result.depositTotal ?? null,
          cumulativeClaimed: result.cumulativeClaimed ?? "0",
        })
      : null;
    results.set(
      entry.pubkey,
      split === null
        ? null
        : { channelId: entry.channelId, source: "claim-state", ...split },
    );
  });

  return results;
}
