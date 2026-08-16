import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { KIND_FACTORY_JOB_REQUEST } from "../../src/shared/constants/kinds";
import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#134 AC3 — the provider surface's freshness invariant
 * (`providerAvailability.ts`, "the socket is the lease"), all three states
 * `useProviderAvailability` can report once advertising is on:
 *
 * - `pending` — no lease TTL has been advertised by the connector. NOT "no
 *   write has landed": with no `toonSessionLeaseTtlMs` fixture the fake
 *   client's `getLastConnectorRouteTerms` answers `undefined`, so however many
 *   writes land none of them can capture a lease — same as a real connector
 *   predating toon-client#509. (As of buzz#213 the kind:20001 presence
 *   heartbeat rides the free ephemeral lane — `ToonPaidWriter.publishEphemeral`,
 *   not `publish` — and that path never calls `captureSessionLease`, so it
 *   still isn't one of the writes that could capture a lease.)
 * - `available` — a TTL is advertised and a paid write has captured it while
 *   it has not yet elapsed. The bridge reads the TTL fixture at CALL time
 *   (`createE2eToonPaidClient`), so the spec sets it live mid-test — AFTER
 *   asserting `pending` — and the next successful write on the shared
 *   `ToonPaidWriter` (the quote this spec sends) captures the lease.
 * - `stale` — a captured lease has elapsed with no fresh write in between:
 *   reach `available` on a short nonzero TTL, then let the hook's 5s tick
 *   re-derive `nowMs >= expiresAtMs`. Nothing pays in the window the spec
 *   waits in — the 60s presence heartbeat rides the free ephemeral lane
 *   (buzz#213) and never calls `captureSessionLease` — so no write refreshes
 *   the lease under the assertion.
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

/**
 * Open the provider panel with advertising on and NO lease TTL advertised, so
 * availability deterministically reads `pending` regardless of how many paid
 * writes have already landed.
 */
async function openProviderPanel(page: Page) {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonJobMarketEvents: [SEEDED_JOB_REQUEST],
  });
  await page.goto("/");
  await page.getByTestId("open-jobs-view").click();
  await page.getByRole("button", { name: "Providing" }).click();
  await page.getByLabel("Serve jobs from the open factory job market").click();
}

/**
 * Advertise a session lease TTL mid-test. The bridge's fake TOON client reads
 * `toonSessionLeaseTtlMs` live from `window.__BUZZ_E2E__` on every
 * `getLastConnectorRouteTerms` call (see `createE2eToonPaidClient`), so the
 * NEXT successful paid write captures a lease with this TTL.
 */
async function advertiseSessionLeaseTtl(page: Page, ttlMs: number) {
  await page.evaluate((value) => {
    const testWindow = window as Window & {
      __BUZZ_E2E__?: { mock?: { toonSessionLeaseTtlMs?: number } };
    };
    testWindow.__BUZZ_E2E__ ??= {};
    testWindow.__BUZZ_E2E__.mock ??= {};
    testWindow.__BUZZ_E2E__.mock.toonSessionLeaseTtlMs = value;
  }, ttlMs);
}

/**
 * Send a quote for the one seeded inbound job — a real paid write through the
 * shared `ToonPaidWriter` (`postFactoryJobQuote` → `transport.publish`) the
 * spec can trigger on demand, so once a TTL is advertised the lease capture
 * happens on the spec's schedule.
 */
async function sendQuoteForSeededJob(page: Page) {
  await page.getByRole("button", { name: "Quote" }).click();
  await page.getByLabel("Milestone 1 name").fill("Plan");
  await page.getByLabel("Milestone 1 price in USDC").fill("1");
  await page.getByRole("button", { name: "Send quote" }).click();
  await expect(page.getByText("1 quote sent this session.")).toBeVisible();
}

test("reads pending while the connector advertises no lease TTL", async ({
  page,
}) => {
  await openProviderPanel(page);

  await expect(
    page.getByText("Publishing this agent's provider listing…"),
  ).toBeVisible();
});

test("reads available once a paid write captures a live-advertised lease", async ({
  page,
}) => {
  await openProviderPanel(page);

  await expect(
    page.getByText("Publishing this agent's provider listing…"),
  ).toBeVisible();

  await advertiseSessionLeaseTtl(page, 60_000);
  await sendQuoteForSeededJob(page);

  await expect(
    page.getByText("Advertised as available to buyers on the open job market."),
  ).toBeVisible();
});

test("degrades from available to stale once the captured lease elapses", async ({
  page,
}) => {
  await openProviderPanel(page);

  await expect(
    page.getByText("Publishing this agent's provider listing…"),
  ).toBeVisible();

  // Short but nonzero: long enough for the quote to land inside the lease
  // (so `available` is observable), short enough to elapse while the spec
  // watches. Stale is then due within TTL (3s) + one availability tick (5s).
  await advertiseSessionLeaseTtl(page, 3_000);
  await sendQuoteForSeededJob(page);

  await expect(
    page.getByText("Advertised as available to buyers on the open job market."),
  ).toBeVisible();

  await expect(
    page.getByText(
      "Not currently reachable — this agent's provider listing will not accept new jobs until its connector session reconnects.",
    ),
  ).toBeVisible({ timeout: 15_000 });
});
