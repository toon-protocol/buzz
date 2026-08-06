import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_REQUEST,
} from "../../src/shared/constants/kinds";
import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#134 AC1 — the buyer surface (buzz#85): post a job, compare quotes,
 * open the job thread, and see the exposure banner. The fake TOON socket
 * (`e2eBridgeToon.ts`'s `createE2eToonSocketFactory`, buzz#134) answers
 * `fetchEvents`/`subscribeLive` from a fixed fixture list rather than a live
 * relay, so "compare quotes" and "job thread" are driven by a pre-seeded
 * kind:5097 job request (authored by this identity, so it shows in "Your
 * jobs") plus a kind:7000 quote answering it — not by an actual post-then-
 * arrive round trip, since a freshly posted job's id is only known after a
 * real (mocked) signature and cannot be pre-seeded. The "post a job" step is
 * covered separately, asserting the form's own success signal (it clears on
 * a successful publish) rather than the pre-existing gap where `useOwnFactoryJobs`
 * has no live subscription and so does not show a just-posted job without a
 * remount.
 */

const SELF_PUBKEY = "deadbeef".repeat(8);
const PROVIDER_PUBKEY = "c0ffee00".repeat(8);
const SEEDED_JOB_ID = "e2e-fixture-factory-job-buyer-journey";
const SEEDED_QUOTE_ID = "e2e-fixture-factory-quote-buyer-journey";

const SEEDED_JOB_REQUEST = {
  id: SEEDED_JOB_ID,
  pubkey: SELF_PUBKEY,
  created_at: 1_700_000_000,
  kind: KIND_FACTORY_JOB_REQUEST,
  content: "",
  tags: [
    ["i", "Refactor the auth module for clarity", "text"],
    ["bid", "10000000", "usdc"],
  ],
  sig: "",
};

const SEEDED_QUOTE = {
  id: SEEDED_QUOTE_ID,
  pubkey: PROVIDER_PUBKEY,
  created_at: 1_700_000_100,
  kind: KIND_FACTORY_JOB_FEEDBACK,
  content: JSON.stringify({
    increments: [
      { n: 1, of: 2, milestone: "Plan", priceUsdc: "1000000" },
      { n: 2, of: 2, milestone: "Implement", priceUsdc: "4000000" },
    ],
  }),
  tags: [
    ["status", "quote"],
    ["e", SEEDED_JOB_ID, "", "root"],
    ["p", SELF_PUBKEY],
  ],
  sig: "",
};

async function openJobsBuyingTab(page: Page) {
  await page.goto("/");
  await page.getByTestId("open-jobs-view").click();
  // "Buying" is the screen's default mode, but click it explicitly so this
  // spec does not depend on that default staying unchanged.
  await page.getByRole("button", { name: "Buying" }).click();
}

test("posts a job and clears the form on success", async ({ page }) => {
  await installMockBridge(page, { transportEnv: { BUZZ_TRANSPORT: "toon" } });
  await openJobsBuyingTab(page);

  const brief = page.getByLabel("Job brief");
  const bid = page.getByLabel("Bid cap in USDC");

  await brief.fill("Add dark mode to the settings screen");
  await bid.fill("3");
  await expect(page.getByRole("button", { name: "Post job" })).toBeEnabled();
  await page.getByRole("button", { name: "Post job" }).click();

  // `postFactoryJob` publishes on the fake TOON writer, which always
  // succeeds — the form clearing itself is `PostJobForm`'s own success
  // signal (`onPosted` fires only after the await resolves).
  await expect(brief).toHaveValue("");
  await expect(bid).toHaveValue("");
});

test("compares a seeded quote and shows the exposure banner in the job thread", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonJobMarketEvents: [SEEDED_JOB_REQUEST, SEEDED_QUOTE],
  });
  await openJobsBuyingTab(page);

  await page.getByText("Refactor the auth module for clarity").click();

  await expect(
    page.getByText(
      "New providers — no history to show yet, shown deliberately rather than sorted to the bottom",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("New provider — no job history yet"),
  ).toBeVisible();

  await page.getByText("New provider — no job history yet").click();

  await expect(
    page.getByText(
      "Paid nothing yet, out of 2 quoted increments. Stopping now costs nothing.",
    ),
  ).toBeVisible();
  await expect(page.getByText("1/2 — Plan")).toBeVisible();
  await expect(page.getByText("2/2 — Implement")).toBeVisible();
});
