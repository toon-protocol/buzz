import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// buzz#131 — demonstration spec (AC4): the Money tab is reachable and
// renders real numbers under the TOON transport, driven entirely by the
// e2e bridge's fake payment client (no real connector, no real devnet).
// See `desktop/src/testing/e2eBridgeToon.ts` for the fake client/claim-state
// fixture this spec seeds.

const SELF_PUBKEY = "deadbeef".repeat(8);

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
