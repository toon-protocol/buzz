import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#133 AC2 — the fleet runway badge (`AgentIdentityCard`'s `statusBadge`
 * slot) and the sidebar low-funds alert (`SidebarLowFundsCard`) at both
 * severity thresholds (`agentFleetRunway.ts`'s `AGENT_FLEET_RUNWAY_CRITICAL_DAYS`
 * / `AGENT_FLEET_RUNWAY_WARNING_DAYS`). Both surfaces derive from the same
 * `useAgentFleetStatus` read for the fleet agent whose pubkey matches the
 * bridge's default identity (`SELF_PUBKEY`), so one seeded managed agent
 * exercises both at once.
 *
 * "critical" is reached via the "depleted" claim-state fixture (spendable
 * balance of exactly zero — `deriveNetworkRunway`'s `"depleted"` branch),
 * which needs no burn-rate sample. "warning" needs an actual finite runway
 * in [1, 3) days, which only ever comes from a live burn-rate sample
 * (`networkSpendLiveStore.ts`) — seeded here via `toonBurnRateSeedBaseUnits`
 * (see `e2eBridgeToon.ts`'s `seedMockNetworkBurnRateReceipt`).
 */

const SELF_PUBKEY = "deadbeef".repeat(8);
const PERSONA_ID = "custom:fleet-runway";
const AGENT_NAME = "Runway Test Agent";

/**
 * Seed one running managed agent owned by the bridge's default identity, on
 * TOON transport, funded per the fixtures a test picks. Only those fixtures
 * differ between the two tests here, so each test body reads as just its
 * funding state and the badge that state must produce.
 */
async function installFleetBridge(
  page: Page,
  toon: {
    claimState: "depleted" | "low-runway";
    burnRateSeedBaseUnits?: number;
  },
) {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: toon.claimState,
    toonBurnRateSeedBaseUnits: toon.burnRateSeedBaseUnits,
    personas: [
      {
        id: PERSONA_ID,
        displayName: AGENT_NAME,
        systemPrompt: "A test persona for fleet-runway E2E coverage.",
        isActive: true,
      },
    ],
    managedAgents: [
      {
        pubkey: SELF_PUBKEY,
        name: AGENT_NAME,
        personaId: PERSONA_ID,
        status: "running",
      },
    ],
  });
}

/** The sidebar alert must count the one seeded agent as needing attention. */
async function expectLowFundsAlert(page: Page) {
  const lowFundsCard = page.getByTestId("sidebar-low-funds");
  await expect(lowFundsCard).toBeVisible();
  await expect(lowFundsCard).toContainText("1 agent low on funds");
}

/** Open the Agents view and return the seeded agent's runway badge. */
async function openAgentsViewAndFindBadge(page: Page) {
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("unified-agents-groups")).toBeVisible({
    timeout: 10_000,
  });

  const badge = page.getByTestId("agent-runway-badge");
  await expect(badge).toBeVisible();
  return badge;
}

test("shows the critical badge and low-funds alert for a depleted fleet agent", async ({
  page,
}) => {
  await installFleetBridge(page, { claimState: "depleted" });
  await page.goto("/");

  await expectLowFundsAlert(page);
  const badge = await openAgentsViewAndFindBadge(page);
  await expect(badge).toContainText("Out of funds");
});

test("shows the warning badge and low-funds alert for a fleet agent with a finite runway", async ({
  page,
}) => {
  // "low-runway"'s spendable balance is 10_000 base units. A single
  // 17-base-unit receipt over the tracker's fixed 300s window gives a burn
  // rate of 17/300 ≈ 0.0567/s, i.e. ~176_471s (~2.04 days) of runway —
  // inside [1, 3) days, `agentFleetRunway.ts`'s "warning" band.
  await installFleetBridge(page, {
    claimState: "low-runway",
    burnRateSeedBaseUnits: 17,
  });
  await page.goto("/");

  await expectLowFundsAlert(page);
  const badge = await openAgentsViewAndFindBadge(page);
  await expect(badge).toContainText("2 days left");
});
