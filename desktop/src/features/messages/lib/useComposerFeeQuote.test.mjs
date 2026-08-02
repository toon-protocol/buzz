import assert from "node:assert/strict";
import test from "node:test";

import { quoteComposerFee } from "./useComposerFeeQuote.ts";

/**
 * Covers buzz#30: the everyday composer's per-message fee must be quoted
 * only on the TOON transport, and a failed quote must resolve to "show
 * nothing" rather than reject — the composer's send button is never blocked
 * by a fee it could not learn.
 *
 * `quoteComposerFee` is exported apart from the `useComposerFeeQuote` hook
 * precisely so these branches are testable without mounting React (this
 * repo's unit tests run under plain `node:test`, no DOM/testing-library —
 * see `MessageComposerAutoSend.test.mjs`'s header comment).
 */

function mockTransport(behavior) {
  return {
    quoteFee: () =>
      behavior === "reject"
        ? Promise.reject(new Error("no route price"))
        : Promise.resolve(behavior),
  };
}

test("toon mode with a priced route resolves the quoted amount", async () => {
  const transport = mockTransport(1000n);
  const fee = await quoteComposerFee(transport, true);
  assert.equal(fee, 1000n);
});

test("toon mode with a zero-fee route resolves zero, not null", async () => {
  const transport = mockTransport(0n);
  const fee = await quoteComposerFee(transport, true);
  assert.equal(fee, 0n);
});

test("toon mode whose quote fails resolves null, never rejects", async () => {
  const transport = mockTransport("reject");
  const fee = await quoteComposerFee(transport, true);
  assert.equal(fee, null);
});

test("relay mode never asks the transport, even if one is passed", async () => {
  let asked = false;
  const transport = {
    quoteFee: () => {
      asked = true;
      return Promise.resolve(1000n);
    },
  };
  const fee = await quoteComposerFee(transport, false);
  assert.equal(fee, null);
  assert.equal(asked, false, "quoteFee must not be called in relay mode");
});

test("toon mode with no transport installed yet resolves null", async () => {
  const fee = await quoteComposerFee(null, true);
  assert.equal(fee, null);
});
