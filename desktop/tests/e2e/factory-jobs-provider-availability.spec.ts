import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { KIND_FACTORY_JOB_REQUEST } from "../../src/shared/constants/kinds";
import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#134 AC3 — the provider surface's freshness invariant
 * (`providerAvailability.ts`, "the socket is the lease"), all three states
 * `useProviderAvailability` can report once advertising is on:
 *
 * - `pending` — advertising just turned on, no paid write has landed yet.
 *   Reachable with no extra bridge config: the fake TOON client's
 *   `getLastConnectorRouteTerms` answers `undefined` until a lease TTL is
 *   seeded (`toonSessionLeaseTtlMs`), same as a real connector predating
 *   toon-client#509.
 * - `available` — a paid write landed and the seeded TTL has not elapsed.
 *   Sending a quote for a seeded inbound job IS that write (`postFactoryJobQuote`
 *   → `transport.publish`), and `ProviderJobsPanel` shares its transport with
 *   the rest of the app, so this is a real write through the fake client, not
 *   a stubbed availability value.
 * - `stale` — a paid write landed but the seeded TTL is `0`, so the very next
 *   render (triggered by `ToonPaidWriter.onPaidWrite`, fired synchronously
 *   after the write) already reads `nowMs >= expiresAtMs`.
 */

const BUYER_PUBKEY = "b0b0b0b0".repeat(8);
const SEEDED_JOB_ID = "e2e-fixture-factory-job-availability";

const SEEDED_JOB_REQUEST = {
  id: SEEDED_JOB_ID,
  pubkey: BUYER_PUBKEY,
  created_at: 1_700_000_000,
  kind: KIND_FACTORY_JOB_REQUEST,
  content: "",
  tags: [
    ["i", "Refactor the auth module for clarity", "text"],
    ["bid", "5000000", "usdc"],
  ],
  sig: "",
};

async function openProviderPanel(
  page: Page,
  toon: { sessionLeaseTtlMs?: number },
) {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonSessionLeaseTtlMs: toon.sessionLeaseTtlMs,
    toonJobMarketEvents: [SEEDED_JOB_REQUEST],
  });
  await page.goto("/");
  await page.getByTestId("open-jobs-view").click();
  await page.getByRole("button", { name: "Providing" }).click();
  await page.getByLabel("Serve jobs from the open factory job market").click();
}

/** Send a quote for the one seeded inbound job — the paid write that captures a session lease. */
async function sendQuoteForSeededJob(page: Page) {
  await page.getByRole("button", { name: "Quote" }).click();
  await page.getByLabel("Milestone 1 name").fill("Plan");
  await page.getByLabel("Milestone 1 price in USDC").fill("1");
  await page.getByRole("button", { name: "Send quote" }).click();
  await expect(page.getByText("1 quote sent this session.")).toBeVisible();
}

test("reads pending before any paid write has landed", async ({ page }) => {
  await openProviderPanel(page, {});

  await expect(
    page.getByText("Publishing this agent's provider listing…"),
  ).toBeVisible();
});

test("reads available once a paid write lands inside the seeded lease", async ({
  page,
}) => {
  await openProviderPanel(page, { sessionLeaseTtlMs: 60_000 });

  await expect(
    page.getByText("Publishing this agent's provider listing…"),
  ).toBeVisible();

  await sendQuoteForSeededJob(page);

  await expect(
    page.getByText("Advertised as available to buyers on the open job market."),
  ).toBeVisible();
});

test("reads stale once a paid write lands with an already-elapsed lease", async ({
  page,
}) => {
  await openProviderPanel(page, { sessionLeaseTtlMs: 0 });

  await sendQuoteForSeededJob(page);

  await expect(
    page.getByText(
      "Not currently reachable — this agent's provider listing will not accept new jobs until its connector session reconnects.",
    ),
  ).toBeVisible();
});
