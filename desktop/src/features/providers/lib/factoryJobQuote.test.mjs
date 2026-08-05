import assert from "node:assert/strict";
import test from "node:test";

import { parseFactoryJobFeedback } from "@/features/factory-jobs/lib/factoryJobFeedback.ts";
import { buildFactoryJobQuote } from "./factoryJobQuote.ts";

test("builds the status/root-e/buyer-p tags and a numbered increment schedule", () => {
  const template = buildFactoryJobQuote({
    rootJobId: "job-1",
    buyerPubkey: "buyer-1",
    increments: [
      { milestone: "plan", priceUsdcBaseUnits: 1_000_000n },
      { milestone: "implement", priceUsdcBaseUnits: 4_000_000n },
    ],
  });

  assert.equal(template.kind, 7000);
  assert.deepEqual(template.tags, [
    ["status", "quote"],
    ["e", "job-1", "", "root"],
    ["p", "buyer-1"],
  ]);
  assert.deepEqual(JSON.parse(template.content), {
    increments: [
      { n: 1, of: 2, milestone: "plan", priceUsdc: "1000000" },
      { n: 2, of: 2, milestone: "implement", priceUsdc: "4000000" },
    ],
  });
});

test("rejects an empty schedule, a blank milestone, and a non-positive price", () => {
  assert.throws(() =>
    buildFactoryJobQuote({
      rootJobId: "job-1",
      buyerPubkey: "buyer-1",
      increments: [],
    }),
  );
  assert.throws(() =>
    buildFactoryJobQuote({
      rootJobId: "job-1",
      buyerPubkey: "buyer-1",
      increments: [{ milestone: "  ", priceUsdcBaseUnits: 1n }],
    }),
  );
  assert.throws(() =>
    buildFactoryJobQuote({
      rootJobId: "job-1",
      buyerPubkey: "buyer-1",
      increments: [{ milestone: "plan", priceUsdcBaseUnits: 0n }],
    }),
  );
});

test("rejects a missing root job id", () => {
  assert.throws(() =>
    buildFactoryJobQuote({
      rootJobId: "  ",
      buyerPubkey: "buyer-1",
      increments: [{ milestone: "plan", priceUsdcBaseUnits: 1n }],
    }),
  );
});

test("rejects a missing buyer pubkey — the quote's spec-Required p tag has nothing to carry", () => {
  assert.throws(() =>
    buildFactoryJobQuote({
      rootJobId: "job-1",
      buyerPubkey: "  ",
      increments: [{ milestone: "plan", priceUsdcBaseUnits: 1n }],
    }),
  );
});

test("round-trips through the buyer side's parseFactoryJobFeedback", () => {
  const template = buildFactoryJobQuote({
    rootJobId: "job-1",
    buyerPubkey: "buyer-pubkey",
    increments: [{ milestone: "plan", priceUsdcBaseUnits: 1_000_000n }],
  });

  const parsed = parseFactoryJobFeedback({
    id: "quote-event",
    pubkey: "provider-pubkey",
    created_at: 1_700_000_000,
    kind: template.kind,
    content: template.content,
    tags: template.tags,
  });

  assert.deepEqual(parsed, {
    eventId: "quote-event",
    providerPubkey: "provider-pubkey",
    createdAt: 1_700_000_000,
    rootJobId: "job-1",
    status: "quote",
    increments: [
      { n: 1, of: 1, milestone: "plan", priceUsdcBaseUnits: 1_000_000n },
    ],
  });
});
