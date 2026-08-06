import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// buzz#131 — demonstration spec (AC4): the Money tab is reachable and
// renders real numbers under the TOON transport, driven entirely by the
// e2e bridge's fake payment client (no real connector, no real devnet).
// See `desktop/src/testing/e2eBridgeToon.ts` for the fake client/claim-state
// fixture this spec seeds.

const SELF_PUBKEY = "deadbeef".repeat(8);
// A managed agent this desktop owns but has never provisioned a channel for
// (no `accountIndex` seed, so the mocked `get_managed_agent_account_index`
// answers `null` — buzz#133's "no-channel" state).
const UNPROVISIONED_AGENT_PUBKEY = "c0ffee00".repeat(8);

test("renders the Money tab's network spend in a seeded funded state on TOON transport", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: "funded",
  });

  // Deep-link straight to the self profile panel's Money tab (`profileTab`
  // is a registered, deep-linkable search param on the home route) — chat
  // history is not needed and, on TOON transport, is not read through this
  // bridge's fake relay socket anyway.
  await page.goto(`/?profile=${SELF_PUBKEY}&profileTab=money`);

  const moneyTab = page.getByTestId("user-profile-money-tab");
  await expect(moneyTab).toBeVisible();

  const networkSpend = page.getByTestId("user-profile-money-network-spend");
  await expect(networkSpend).toBeVisible();
  // A funded claim state must resolve to the "quoted" balance view, never
  // the relay/pending/unavailable notices `NetworkSpendBody` falls back to.
  await expect(
    page.getByTestId("user-profile-money-network-spend-unavailable"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("user-profile-money-network-balance"),
  ).toContainText("9.95 USDC");
  await expect(
    page.getByTestId("user-profile-money-network-allowance"),
  ).toContainText("10.00 USDC");
});

test("renders a near-exhausted balance for the low-runway claim-state fixture", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: "low-runway",
  });

  await page.goto(`/?profile=${SELF_PUBKEY}&profileTab=money`);

  await expect(
    page.getByTestId("user-profile-money-network-balance"),
  ).toContainText("0.01 USDC");
});

test("falls back to the locally-tracked channel read for the stale-lease claim-state fixture", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: "stale-lease",
  });

  await page.goto(`/?profile=${SELF_PUBKEY}&profileTab=money`);

  // "stale-lease" answers `ok: false, error: "expired"` from the fake
  // connector, so `ToonPaidWriter.tryClaimState` yields no verified read and
  // `getNetworkFlowStatus` falls back to the fake client's locally-tracked
  // channel numbers (deposit 0.50 USDC, claimed 0.10 USDC). The block must
  // still render real figures — never the "unavailable" notice — and the
  // figures must be the LOCAL pair, proving the fallback path ran rather
  // than any claim-state fixture leaking through.
  await expect(
    page.getByTestId("user-profile-money-network-spend"),
  ).toBeVisible();
  await expect(
    page.getByTestId("user-profile-money-network-spend-unavailable"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("user-profile-money-network-balance"),
  ).toContainText("0.40 USDC");
  await expect(
    page.getByTestId("user-profile-money-network-allowance"),
  ).toContainText("0.50 USDC");
});

// buzz#133 AC1 — the third Money-tab state the ticket asks for, alongside
// the funded/low-runway cases above: an agent this desktop owns but that has
// never had a channel opened for it. Viewed as a non-`isSelf` agent so the
// read goes through `readSingleAgentNetworkFlowStatus` (`useNetworkSpend.ts`)
// rather than the self writer — that path returns `null` outright once
// `getManagedAgentAccountIndex` can't find an assigned index, without ever
// asking the fake claim-state client, which is what "no channel exists yet"
// actually means for a fleet agent (buzz#109 / `docs/adr/0007`).
test("renders the unavailable notice for a managed agent with no provisioned channel", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: "funded",
    managedAgents: [
      {
        pubkey: UNPROVISIONED_AGENT_PUBKEY,
        name: "Unprovisioned Agent",
        status: "stopped",
        // No `accountIndex` — this agent has never been assigned one.
      },
    ],
  });

  await page.goto(`/?profile=${UNPROVISIONED_AGENT_PUBKEY}&profileTab=money`);

  await expect(page.getByTestId("user-profile-money-tab")).toBeVisible();
  await expect(
    page.getByTestId("user-profile-money-network-spend-unavailable"),
  ).toBeVisible();
  await expect(
    page.getByTestId("user-profile-money-network-spend-unavailable"),
  ).toContainText("No payment channel could be found for this agent yet.");
  await expect(
    page.getByTestId("user-profile-money-network-balance"),
  ).toHaveCount(0);
});
