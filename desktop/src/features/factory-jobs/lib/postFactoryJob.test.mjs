import assert from "node:assert/strict";
import test from "node:test";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { unwrapEvent } from "nostr-tools/nip59";

import { buildFactoryJobRequest } from "./factoryJobRequest.ts";
import { postFactoryJob, wrapFactoryJobRequest } from "./postFactoryJob.ts";

test("a gift-wrapped job request is unreadable without the recipient's key", () => {
  const buyerSecretKey = generateSecretKey();
  const providerSecretKey = generateSecretKey();
  const providerPubkey = getPublicKey(providerSecretKey);

  const template = buildFactoryJobRequest({
    brief: "Implement buzz#56, privately",
    bidBaseUnits: 5_000_000n,
    targetProviderPubkey: providerPubkey,
  });

  const wrap = wrapFactoryJobRequest(template, buyerSecretKey, providerPubkey);

  assert.equal(wrap.kind, 1059);
  // The relay must see neither content nor sender (decision 1) — the wrap's
  // own signer is an ephemeral key, not the buyer's.
  assert.notEqual(wrap.pubkey, getPublicKey(buyerSecretKey));
  assert.doesNotMatch(wrap.content, /buzz#56/);
  assert.doesNotMatch(JSON.stringify(wrap.tags), /buzz#56/);
});

test("the targeted provider can unwrap it back to the original brief", () => {
  const buyerSecretKey = generateSecretKey();
  const providerSecretKey = generateSecretKey();
  const providerPubkey = getPublicKey(providerSecretKey);

  const template = buildFactoryJobRequest({
    brief: "Implement buzz#56, privately",
    bidBaseUnits: 5_000_000n,
    targetProviderPubkey: providerPubkey,
  });

  const wrap = wrapFactoryJobRequest(template, buyerSecretKey, providerPubkey);
  const rumor = unwrapEvent(wrap, providerSecretKey);

  assert.equal(rumor.kind, 5097);
  assert.deepEqual(rumor.tags, template.tags);
});

test("postFactoryJob refuses to gift-wrap without a targeted provider", async () => {
  // Regression: gift-wrap is a buyer choice independent of targeting (spec
  // §2.1 allows a public, targeted `p` tag with no encryption) — this must
  // reject rather than silently posting in the open when the caller asked
  // for a private wrap it cannot construct.
  await assert.rejects(
    () =>
      postFactoryJob(
        { brief: "Implement buzz#56", bidBaseUnits: 5_000_000n },
        /** @type {any} */ ({ publish: () => assert.fail("must not publish") }),
        { giftWrap: true },
      ),
    /gift-wrap.*targeted provider/i,
  );
});
