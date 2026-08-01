/**
 * USDC has 6 decimals on every settlement chain the devnet offers — matches
 * `SETTLEMENT_ASSET_SCALE` in `toonPaidWriter.ts`. Kept as its own small
 * constant here rather than importing that module's internal, since the
 * wizard formats amounts (a per-message fee quote, the channel-open
 * collateral estimate, a wallet balance) that never touch a paid write.
 */
const USDC_DECIMALS = 6;

/** Render a base-unit USDC amount as the fee/collateral/balance line a user sees. */
export function formatUsdcBaseUnits(amount: bigint): string {
  const divisor = 10 ** USDC_DECIMALS;
  const value = Number(amount) / divisor;
  // Sub-cent amounts are the normal case for a per-message fee, so a fixed
  // 2dp would render every quote as "0.00".
  const text = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: USDC_DECIMALS,
  });
  return `${text} USDC`;
}

/**
 * The channel-open collateral the wizard shows BEFORE the user consents to
 * opening one.
 *
 * This is `ChannelManagerConfig`'s own default (`@toon-protocol/client`,
 * `initialDeposit: '100000'` = 0.1 USDC) — Buzz's `createToonClient` does not
 * override it (`toonPaidWriter.ts`). A connector that negotiates a different
 * amount would make this estimate wrong, which is why the wizard's copy
 * hedges with "up to" rather than presenting it as exact.
 */
export const DEFAULT_CHANNEL_COLLATERAL_BASE_UNITS = 100_000n;
