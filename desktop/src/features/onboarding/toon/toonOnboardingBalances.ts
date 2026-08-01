import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";

/**
 * Read the wizard's settlement-chain balances for one address.
 *
 * A free, read-only RPC call — deliberately independent of the paid client:
 * the fund step needs to know what landed before the wizard has any reason to
 * start a channel client. `@toon-protocol/client` is imported lazily for the
 * same reason every other TOON entry point in this app is (see
 * `toonPaidWriter.ts`).
 */

export type ToonOnboardingBalances = {
  /** Settlement-token (USDC) balance, base units. Null when unreadable. */
  tokenBaseUnits: bigint | null;
  /** Native-gas balance, base units. Null when unreadable. */
  nativeBaseUnits: bigint | null;
  /** The RPC could not be reached at all. */
  unreadable: boolean;
};

function toBigIntOrNull(amount: string | undefined): bigint | null {
  if (amount === undefined) return null;
  try {
    return BigInt(amount);
  } catch {
    return null;
  }
}

export async function readToonOnboardingBalances(
  config: Pick<ToonTransportConfig, "chain" | "chainRpcUrl" | "preferredToken">,
  address: string,
): Promise<ToonOnboardingBalances> {
  const { readWalletBalances } = await import("@toon-protocol/client");
  const [chainBalances] = await readWalletBalances({
    evm: {
      chainKey: config.chain,
      rpcUrl: config.chainRpcUrl,
      owner: address,
      tokenAddress: config.preferredToken,
    },
  });

  if (!chainBalances || chainBalances.unreadable) {
    return { tokenBaseUnits: null, nativeBaseUnits: null, unreadable: true };
  }

  return {
    tokenBaseUnits: toBigIntOrNull(chainBalances.tokens[0]?.amount),
    nativeBaseUnits: toBigIntOrNull(chainBalances.native?.amount),
    unreadable: false,
  };
}
