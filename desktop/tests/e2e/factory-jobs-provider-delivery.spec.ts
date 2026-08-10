import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_REQUEST,
  KIND_FACTORY_JOB_RESULT,
} from "../../src/shared/constants/kinds";
import { installMockBridge } from "../helpers/bridge";

/**
 * buzz#135 AC6 — the provider delivery flow end to end on the mock bridge:
 * deliver the (only) increment — encrypt, upload the ciphertext, publish the
 * kind:7000 `status:"partial"` offer, wait for payment — narrate for free,
 * then the buyer "pays" via `window.__BUZZ_E2E_PAY_ARMED_INCREMENT__`
 * (`e2eBridgeToon.ts`'s `payArmedFactoryJobIncrement`, wired in
 * `e2eBridge.ts`): it drives the REAL `ClientJobDeliveryPort.handleJob` the
 * fake TOON client captured off the delivery-port factory argument, exactly
 * like a real connector-originated PREPARE would. That unblocks
 * `waitForPayment` and lets the flow publish the terminal kind:6097
 * `completed` result. `uploadBlob`/`sendSwapPacket` stay the existing fakes
 * (`e2eBridgeToon.ts`) — nothing new there.
 *
 * Every published event is captured via `window.__BUZZ_E2E_SIGNED_EVENTS__`
 * (populated on every `sign_event` Tauri call — the mechanism
 * `deliverFactoryJobIncrement.ts`'s `signRelayEvent` rides) and asserted for
 * the narration → offer → result publish order and the §4.1/§5.1 tag
 * shapes.
 *
 * The quote is pre-seeded (authored by SELF_PUBKEY) rather than sent
 * interactively: the fake TOON socket only answers a REQ from events seeded
 * BEFORE it arrives (`e2eBridgeToon.ts`'s own doc — it never pushes a live
 * frame into an already-open subscription), so a quote published live within
 * the test would never read back through `useFactoryJobFeedback` /
 * `useInboundFactoryJobs`'s `alreadyQuoted` check — the same limitation
 * `factory-jobs-buyer-journey.spec.ts` works around for "compare quotes".
 */

const SELF_PUBKEY = "deadbeef".repeat(8);
const BUYER_PUBKEY = "b0b0b0b0".repeat(8);
const SEEDED_JOB_ID = "e2e-fixture-factory-job-provider-delivery";
const SEEDED_QUOTE_ID = "e2e-fixture-factory-quote-provider-delivery";
const SEEDED_BRIEF = "Write a one-page project README";
const NARRATION_MESSAGE = "Starting on the README now.";
const ARTIFACT_TEXT = "# Project\n\nA one-page README.";

const SEEDED_JOB_REQUEST = {
  id: SEEDED_JOB_ID,
  pubkey: BUYER_PUBKEY,
  created_at: 1_700_000_000,
  kind: KIND_FACTORY_JOB_REQUEST,
  content: "",
  tags: [
    ["i", SEEDED_BRIEF, "text"],
    ["bid", "5000000", "usdc"],
  ],
  sig: "",
};

// Single-increment schedule: paying it completes the job in one step,
// keeping the sequence this spec asserts (offer -> narration -> result)
// unambiguous.
const SEEDED_QUOTE = {
  id: SEEDED_QUOTE_ID,
  pubkey: SELF_PUBKEY,
  created_at: 1_700_000_100,
  kind: KIND_FACTORY_JOB_FEEDBACK,
  content: JSON.stringify({
    increments: [{ n: 1, of: 1, milestone: "implement", priceUsdc: "5000000" }],
  }),
  tags: [
    ["status", "quote"],
    ["e", SEEDED_JOB_ID, "", "root"],
    ["p", BUYER_PUBKEY],
  ],
  sig: "",
};

async function openProviderPanelWithSeededQuote(page: Page) {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon" },
    toonJobMarketEvents: [SEEDED_JOB_REQUEST, SEEDED_QUOTE],
  });
  await page.goto("/");
  await page.getByTestId("open-jobs-view").click();
  await page.getByRole("button", { name: "Providing" }).click();
  await page.getByLabel("Serve jobs from the open factory job market").click();
}

test("delivers the quoted increment, narrates, and completes on payment", async ({
  page,
}) => {
  await openProviderPanelWithSeededQuote(page);

  await expect(page.getByText(SEEDED_BRIEF)).toBeVisible();
  await page.getByRole("button", { name: "Deliver" }).click();

  // Free §6 narration, sendable any time before a terminal state.
  await page.getByLabel("Progress update").fill(NARRATION_MESSAGE);
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(page.getByLabel("Progress update")).toHaveValue("");
  await expect(page.getByText(NARRATION_MESSAGE)).toBeVisible();

  // Deliver the only quoted increment.
  await page.getByLabel("Increment 1 artifact").fill(ARTIFACT_TEXT);
  await page.getByRole("button", { name: /^Deliver increment 1 for/ }).click();

  await expect(page.getByText("Waiting for buyer payment")).toBeVisible();

  // Read the just-published offer's condition tag off the wire capture, then
  // simulate the buyer's payment through the bridge control.
  const conditionHex = await page.evaluate(() => {
    const offer = window.__BUZZ_E2E_SIGNED_EVENTS__?.findLast(
      (event) =>
        event.kind === 7000 &&
        event.tags.some((tag) => tag[0] === "status" && tag[1] === "partial"),
    );
    return offer?.tags.find((tag) => tag[0] === "condition")?.[1] ?? null;
  });
  expect(conditionHex).toMatch(/^[0-9a-f]{64}$/);
  if (!conditionHex) throw new Error("unreachable — asserted above");

  await page.evaluate(
    (hex) => window.__BUZZ_E2E_PAY_ARMED_INCREMENT__?.(hex),
    conditionHex,
  );

  await expect(
    page.getByText(
      "Job completed — every quoted increment was delivered and paid.",
    ),
  ).toBeVisible();

  const events = await page.evaluate(
    () => window.__BUZZ_E2E_SIGNED_EVENTS__ ?? [],
  );

  const narrationEvent = events.find(
    (event) =>
      event.kind === KIND_FACTORY_JOB_FEEDBACK &&
      event.tags.some((tag) => tag[0] === "status" && tag[1] === "processing"),
  );
  const offerEvent = events.find(
    (event) =>
      event.kind === KIND_FACTORY_JOB_FEEDBACK &&
      event.tags.some((tag) => tag[0] === "status" && tag[1] === "partial"),
  );
  const resultEvent = events.find(
    (event) => event.kind === KIND_FACTORY_JOB_RESULT,
  );

  expect(narrationEvent).toBeDefined();
  expect(offerEvent).toBeDefined();
  expect(resultEvent).toBeDefined();

  // Publish order: narration (sent first, while idle) -> offer -> result.
  expect(events.indexOf(narrationEvent)).toBeLessThan(
    events.indexOf(offerEvent),
  );
  expect(events.indexOf(offerEvent)).toBeLessThan(events.indexOf(resultEvent));

  // §6 narration: no artifact tags.
  expect(narrationEvent?.content).toBe(NARRATION_MESSAGE);
  expect(narrationEvent?.tags).toContainEqual(["e", SEEDED_JOB_ID, "", "root"]);
  expect(narrationEvent?.tags).toContainEqual([
    "e",
    SEEDED_QUOTE_ID,
    "",
    "reply",
  ]);

  // §4.1 offer: condition/Arweave-url/ciphertext-hash tags, replying to the
  // quote, one increment of one.
  expect(offerEvent?.tags).toContainEqual(["e", SEEDED_JOB_ID, "", "root"]);
  expect(offerEvent?.tags).toContainEqual(["e", SEEDED_QUOTE_ID, "", "reply"]);
  expect(offerEvent?.tags).toContainEqual(["p", BUYER_PUBKEY]);
  expect(offerEvent?.tags).toContainEqual(["increment", "1", "1"]);
  expect(offerEvent?.tags).toContainEqual(["amount", "5000000", "usdc"]);
  expect(
    offerEvent?.tags.some((tag) => tag[0] === "i" && tag[2] === "url"),
  ).toBe(true);
  expect(
    offerEvent?.tags.some((tag) => tag[0] === "i" && tag[4] === "hash"),
  ).toBe(true);
  expect(offerEvent?.tags.find((tag) => tag[0] === "condition")?.[1]).toBe(
    conditionHex,
  );

  // §5.1 result: completed at 1/1, final artifact tag present.
  expect(resultEvent?.tags).toContainEqual(["outcome", "completed"]);
  expect(resultEvent?.tags).toContainEqual(["increment", "1", "1"]);
  expect(
    resultEvent?.tags.some((tag) => tag[0] === "i" && tag[2] === "url"),
  ).toBe(true);
});

test("delivery is unavailable with a reason when the transport has no BTP session", async ({
  page,
}) => {
  await installMockBridge(page, {
    transportEnv: { BUZZ_TRANSPORT: "toon", BUZZ_TOON_BTP_URL: "off" },
    toonJobMarketEvents: [SEEDED_JOB_REQUEST, SEEDED_QUOTE],
  });
  await page.goto("/");
  await page.getByTestId("open-jobs-view").click();
  await page.getByRole("button", { name: "Providing" }).click();
  await page.getByLabel("Serve jobs from the open factory job market").click();

  await expect(page.getByText(SEEDED_BRIEF)).toBeVisible();
  await page.getByRole("button", { name: "Deliver" }).click();

  await expect(
    page.getByText(
      "Increment delivery needs the connector's BTP session — this transport " +
        "is running one-shot HTTP, so this agent can quote but not deliver.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Deliver increment/ }),
  ).toHaveCount(0);
});
