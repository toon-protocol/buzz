import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#134 AC2 — regression coverage for buzz#121: the Jobs screen's
 * provider toggle used to hard-crash on its first click (React #185,
 * "Maximum update depth exceeded") once ANY provider-capability settings
 * blob already existed in storage — the empty-storage path returned the
 * module-level `DEFAULT_PROVIDER_CAPABILITY_SETTINGS` constant, which was
 * already referentially stable, so the bug only showed up once a real blob
 * was read back through `getProviderCapabilitySettings`'s old fresh-parse-
 * per-call snapshot. buzz#121 (PR #138) fixed the snapshot cache at the hook
 * level (`useProviderCapabilitySettings.test.mjs` mounts the real hook and
 * proves no update loop); this spec is the missing user-level proof — the
 * app has no error boundary anywhere (`grep -rl componentDidCatch` finds
 * none), so a real regression here unmounts the WHOLE React root, not just
 * the panel. Toggling the checkbox and re-asserting it is still there after
 * each click is therefore a strong enough signal: a crash makes the
 * `expect(...).toBeChecked()` calls below time out against a blank page.
 */

const SELF_PUBKEY = "deadbeef".repeat(8);
const PROVIDER_TOGGLE_LABEL = "Serve jobs from the open factory job market";

/** Seed a stored settings blob (buzz#121's own repro condition) before the app boots. */
async function seedStoredProviderCapabilitySettings(page: Page) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    {
      key: `buzz-provider-capability.v1:${SELF_PUBKEY}`,
      value: JSON.stringify({
        enabled: false,
        description: "",
        repoFilter: [],
      }),
    },
  );
}

test("toggling provider advertising on/off repeatedly never crashes the Jobs screen", async ({
  page,
}) => {
  await seedStoredProviderCapabilitySettings(page);
  await installMockBridge(page, { transportEnv: { BUZZ_TRANSPORT: "toon" } });

  await page.goto("/");
  await page.getByTestId("open-jobs-view").click();
  await page.getByRole("button", { name: "Providing" }).click();

  const toggle = page.getByLabel(PROVIDER_TOGGLE_LABEL);
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByText(
      "Turn advertising on above to see open jobs matching what this agent serves.",
    ),
  ).toBeVisible();

  // Five on/off cycles — buzz#121 reproduced on the very first click with a
  // stored blob present, but repeated toggling is the acceptance criterion.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Jobs you can serve")).toBeVisible();
    await expect(
      page.getByText("No open jobs match what this agent currently serves."),
    ).toBeVisible();

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(
      page.getByText(
        "Turn advertising on above to see open jobs matching what this agent serves.",
      ),
    ).toBeVisible();
  }

  // The rest of the app is still alive too — proof the whole root survived,
  // not just this one panel's local state.
  await expect(page.getByTestId("open-jobs-view")).toBeVisible();
});
