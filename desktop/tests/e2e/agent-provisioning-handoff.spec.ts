import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#133 AC4 — regression coverage for buzz#122: before that fix, only the
 * contextual add-bot-to-channel path opened `AgentProvisioningDialog`; every
 * Agents-page surface that mints a new managed agent (new agent,
 * duplicate-persona-and-start, "start this persona now") left a freshly
 * created TOON agent with no wallet and no visible trace once
 * `SecretRevealDialog` closed. This drives the simplest of those three
 * surfaces — "start this persona now" (`handleStartPersona` in
 * `useManagedAgentActions.ts`) — through `useAgentProvisioningHandoff`'s
 * set-then-null transition (`agentProvisioningHandoff.ts`) and asserts the
 * dialog actually opens.
 *
 * The freshly created agent's pubkey is random (`crypto.randomUUID()` in
 * the mock `create_managed_agent` handler), so it is never in this test's
 * static `managedAgents` seed and the mocked `get_managed_agent_account_index`
 * answers `null` for it — same as a real not-yet-registered account index.
 * `deriveAgentProvisioningStatus` reads that as step `"key"`, not an error
 * (see `agentProvisioningState.ts`), so the dialog settles on the key step's
 * waiting copy rather than timing out — the assertion below is exactly that
 * stable state, not a flake waiting on a real Rust-side registry.
 */

const PERSONA_ID = "custom:provisioning-handoff";
const AGENT_NAME = "Handoff Test Agent";

test("hands off to wallet provisioning after starting a persona on TOON transport", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonClaimState: "funded",
    personas: [
      {
        id: PERSONA_ID,
        displayName: AGENT_NAME,
        systemPrompt: "A test persona for provisioning-handoff E2E coverage.",
        isActive: true,
      },
    ],
  });

  await page.goto("/");
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("unified-agents-groups")).toBeVisible({
    timeout: 10_000,
  });

  await page.getByTestId(`persona-runtime-start-${PERSONA_ID}`).click();

  // SecretRevealDialog ("Agent created") shows the freshly minted agent's
  // key. Dismissing it ("Done") is the set-to-null transition
  // `useAgentProvisioningHandoff` watches for.
  await expect(page.getByText("Agent created")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Done" }).click();

  const provisioningDialogTitle = page.getByText(
    `Set up ${AGENT_NAME}'s wallet`,
  );
  await expect(provisioningDialogTitle).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Waiting for the agent's payment key to be assigned…"),
  ).toBeVisible();

  // Declining leaves the buzz#122 AC2 indicator on the agent's card instead
  // of silently dropping back to no wallet/channel with no trace.
  await page.getByRole("button", { name: "Do this later" }).click();
  await expect(provisioningDialogTitle).toHaveCount(0);

  const card = page.getByTestId(`persona-agent-row-${PERSONA_ID}`);
  await expect(card.getByTestId("agent-unprovisioned-badge")).toBeVisible();
});
