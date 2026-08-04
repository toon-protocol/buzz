import assert from "node:assert/strict";
import test from "node:test";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createSeal, createWrap, wrapEvent } from "nostr-tools/nip59";

import { buildFactoryJobRequest } from "@/features/factory-jobs/lib/factoryJobRequest.ts";
import { unwrapFactoryJobRequestGift } from "./unwrapFactoryJobRequest.ts";

test("a well-formed gift-wrapped brief unwraps to the original request and its real sender", () => {
  const buyerSecretKey = generateSecretKey();
  const buyerPubkey = getPublicKey(buyerSecretKey);
  const providerSecretKey = generateSecretKey();
  const providerPubkey = getPublicKey(providerSecretKey);

  const template = buildFactoryJobRequest({
    brief: "Implement buzz#56, privately",
    bidBaseUnits: 5_000_000n,
    repo: "toon-protocol/buzz",
    targetProviderPubkey: providerPubkey,
  });
  const wrap = wrapEvent(template, buyerSecretKey, providerPubkey);

  const grant = unwrapFactoryJobRequestGift(wrap, providerSecretKey);

  assert.ok(grant);
  assert.equal(grant.sender, buyerPubkey);
  assert.equal(grant.wrapId, wrap.id);
  assert.equal(grant.request.brief, "Implement buzz#56, privately");
  assert.equal(grant.request.repo, "toon-protocol/buzz");
  assert.equal(grant.request.bidBaseUnits, 5_000_000n);
  assert.equal(grant.request.eventId, wrap.id);
});

test("a wrap addressed to someone else does not unwrap", () => {
  const buyerSecretKey = generateSecretKey();
  const providerPubkey = getPublicKey(generateSecretKey());
  const someoneElseSecretKey = generateSecretKey();

  const template = buildFactoryJobRequest({
    brief: "Implement buzz#56",
    bidBaseUnits: 1_000_000n,
    targetProviderPubkey: providerPubkey,
  });
  const wrap = wrapEvent(template, buyerSecretKey, providerPubkey);

  assert.equal(unwrapFactoryJobRequestGift(wrap, someoneElseSecretKey), null);
});

test("a forged rumor whose pubkey does not match the seal's signer is rejected", () => {
  const attackerSecretKey = generateSecretKey();
  const victimPubkey = getPublicKey(generateSecretKey());
  const providerSecretKey = generateSecretKey();
  const providerPubkey = getPublicKey(providerSecretKey);

  const forgedRumor = {
    kind: 5097,
    content: "",
    tags: [
      ["i", "Free work, honest", "text"],
      ["bid", "1", "usdc"],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: victimPubkey,
    id: "forged-id",
  };
  const seal = createSeal(forgedRumor, attackerSecretKey, providerPubkey);
  const wrap = createWrap(seal, providerPubkey);

  assert.equal(unwrapFactoryJobRequestGift(wrap, providerSecretKey), null);
});

test("a non-gift-wrap kind is rejected outright", () => {
  const providerSecretKey = generateSecretKey();
  assert.equal(
    unwrapFactoryJobRequestGift(
      /** @type {any} */ ({
        kind: 1,
        pubkey: "x",
        content: "",
        id: "e",
        created_at: 0,
        tags: [],
        sig: "s",
      }),
      providerSecretKey,
    ),
    null,
  );
});
