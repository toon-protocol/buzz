import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#133 AC3 — the Money tab's Network spend "Top up" (refill) flow
 * (`NetworkSpendReady` in `UserProfilePanelNetworkSpend.tsx`), driven
 * entirely by the e2e bridge's fake TOON payment client
 * (`e2eBridgeToon.ts`'s `createE2eToonPaidClient`, whose `depositToChannel`
 * always succeeds — no real connector, no real devnet).
 *
 * Validation is client-side and pure (`paymentsOverview.ts`'s
 * `parseUsdcAmount`): the submit button stays disabled for any input that
 * doesn't parse to a positive USDC amount, so an invalid amount can never
 * reach `network.deposit()` in the first place.
 */

const SELF_PUBKEY = "deadbeef".repeat(8);

async function gotoMoneyTab(page: import("@playwright/test").Page) {
  await page.goto(`/?profile=${SELF_PUBKEY}&profileTab=money`);
  await expect(page.getByTestId("user-profile-money-tab")).toBeVisible();
}

test("keeps the top-up submit disabled for an invalid or zero amount", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: "funded",
  });
  await gotoMoneyTab(page);

  const amountInput = page.getByTestId(
    "user-profile-money-network-deposit-amount",
  );
  const submit = page.getByTestId("user-profile-money-network-deposit-submit");

  // Nothing typed yet.
  await expect(submit).toBeDisabled();

  for (const invalid of ["0", "abc", "-5", "1.1234567"]) {
    await amountInput.fill(invalid);
    await expect(submit).toBeDisabled();
  }

  // A deposit error never surfaced, since no submit ever fired.
  await expect(
    page.getByTestId("user-profile-money-network-deposit-error"),
  ).toHaveCount(0);

  // A valid amount flips the gate back on, proving the disablement above
  // was about the input's content, not some other stuck state.
  await amountInput.fill("5");
  await expect(submit).toBeEnabled();
});

test("tops up the balance and clears the input on success", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: "funded",
  });
  await gotoMoneyTab(page);

  const amountInput = page.getByTestId(
    "user-profile-money-network-deposit-amount",
  );
  const submit = page.getByTestId("user-profile-money-network-deposit-submit");

  await amountInput.fill("5");
  await expect(submit).toBeEnabled();
  await submit.click();

  // `depositToChannel` on the fake client always resolves, so the pending
  // state clears, no error banner appears, and the amount field resets —
  // `NetworkSpendReady`'s success path (`useNetworkSpend.ts`'s `deposit`).
  await expect(submit).toContainText("Top up", { timeout: 10_000 });
  await expect(
    page.getByTestId("user-profile-money-network-deposit-error"),
  ).toHaveCount(0);
  await expect(amountInput).toHaveValue("");
});
