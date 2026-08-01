import assert from "node:assert/strict";
import test from "node:test";

import {
  forgetPermanenceAcknowledgement,
  formatUploadFee,
  hasAcknowledgedPermanence,
  needsPermanenceDisclosure,
  permanenceDisclosureCopy,
} from "./mediaPermanence.ts";
import {
  acceptMediaPermanence,
  declineMediaPermanence,
  getMediaPermanenceDisclosure,
  requireMediaUploadConsent,
  resetMediaPermanenceGate,
} from "./mediaPermanenceGate.ts";
import {
  MediaUploadDeclined,
  MediaUploadUnavailable,
  relayMediaUploader,
  resetMediaUploader,
  setMediaUploader,
} from "./mediaUpload.ts";

const STORE_QUOTE = {
  amount: 1500n,
  asset: "USDC",
  assetScale: 6,
  permanent: true,
  backend: "store",
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

/** Install a media backend whose quote is `quote` and whose uploads no-op. */
function installBackend(quote) {
  setMediaUploader({
    quote: async () => quote,
    upload: async () => {
      throw new Error("not used");
    },
    pickAndUpload: async () => [],
  });
}

test.beforeEach(() => {
  resetMediaPermanenceGate();
  resetMediaUploader();
  // The gate writes through to real `localStorage` when one exists; under
  // node:test there is none, so the module's in-memory fallback is what the
  // acknowledgement lands in. Clear it between tests.
  forgetPermanenceAcknowledgement();
});

test("a relay backend makes no permanence promise, so it never discloses", () => {
  assert.equal(
    needsPermanenceDisclosure(
      {
        amount: 0n,
        asset: "",
        assetScale: 0,
        permanent: false,
        backend: "relay",
      },
      memoryStorage(),
    ),
    false,
  );
});

test("a permanent backend discloses until acknowledged, then stops", () => {
  const storage = memoryStorage();
  assert.equal(needsPermanenceDisclosure(STORE_QUOTE, storage), true);
  storage.setItem("buzz-media-permanence-ack.v1", "true");
  assert.equal(hasAcknowledgedPermanence(storage), true);
  assert.equal(needsPermanenceDisclosure(STORE_QUOTE, storage), false);
});

test("consent for a free relay upload resolves without opening the dialog", async () => {
  setMediaUploader(relayMediaUploader);
  await requireMediaUploadConsent();
  assert.equal(getMediaPermanenceDisclosure(), null);
});

test("the first store upload parks until the user accepts, later ones go straight through", async () => {
  installBackend(STORE_QUOTE);

  const first = requireMediaUploadConsent();
  // The dialog is open and quotes the fee it was given.
  await Promise.resolve();
  const copy = getMediaPermanenceDisclosure();
  assert.notEqual(copy, null);
  assert.match(copy.feeLine, /0\.0015 USDC/);

  acceptMediaPermanence();
  await first;
  assert.equal(getMediaPermanenceDisclosure(), null);

  // Acknowledged: no second dialog.
  await requireMediaUploadConsent();
  assert.equal(getMediaPermanenceDisclosure(), null);
});

test("declining rejects the upload rather than failing it", async () => {
  installBackend(STORE_QUOTE);
  const pending = requireMediaUploadConsent();
  await Promise.resolve();
  declineMediaPermanence();
  await assert.rejects(
    pending,
    (error) => error instanceof MediaUploadDeclined,
  );
  // A decline must NOT be remembered as consent.
  assert.equal(hasAcknowledgedPermanence(), false);
});

test("a multi-file drop asks once and releases every file on one answer", async () => {
  installBackend(STORE_QUOTE);
  const all = [
    requireMediaUploadConsent(),
    requireMediaUploadConsent(),
    requireMediaUploadConsent(),
  ];
  await Promise.resolve();
  await Promise.resolve();
  assert.notEqual(getMediaPermanenceDisclosure(), null);
  acceptMediaPermanence();
  await Promise.all(all);
});

test("a free permanent route still discloses the permanence, just not a fee", () => {
  const copy = permanenceDisclosureCopy({ ...STORE_QUOTE, amount: 0n });
  assert.match(copy.feeLine, /no fee/);
  assert.equal(
    formatUploadFee({ ...STORE_QUOTE, amount: 0n }),
    "no fee on the current route",
  );
});

test("the disclosure names the permanence and never promises a deletion", () => {
  const copy = permanenceDisclosureCopy(STORE_QUOTE);
  const prose = [
    copy.title,
    ...copy.body,
    copy.feeLine,
    copy.confirmLabel,
  ].join(" ");
  assert.match(prose, /permanent/i);
  assert.match(prose, /cannot be removed/i);
  assert.match(prose, /Arweave|permaweb/i);
  // The whole point: no wording here may suggest the file can be taken back.
  assert.doesNotMatch(prose, /\bdelete\b/i);
  assert.doesNotMatch(prose, /\bdeleted\b/i);
  // And the fee is disclosed before the bytes move.
  assert.match(copy.feeLine, /0\.0015 USDC/);
});

test("the disclosure is honest that hiding is not deleting", () => {
  const copy = permanenceDisclosureCopy(STORE_QUOTE);
  const hideParagraph = copy.body.find((line) => /hiding/i.test(line));
  assert.notEqual(hideParagraph, undefined);
  assert.match(hideParagraph, /stays on the permaweb/i);
});

test("an unavailable backend blocks consent instead of asking for it", async () => {
  // The disclosure must not open for an upload that cannot happen — accepting
  // permanence for a write the edge will refuse is consent to nothing.
  setMediaUploader({
    quote: async () => {
      throw new MediaUploadUnavailable(
        "Upload unavailable — the TOON store route is unpriced or unreachable.",
      );
    },
    upload: async () => {
      throw new Error("must not be reached");
    },
    pickAndUpload: async () => [],
  });

  await assert.rejects(
    () => requireMediaUploadConsent(),
    (error) => error instanceof MediaUploadUnavailable,
  );
  assert.equal(getMediaPermanenceDisclosure(), null);
});

test("unavailability is not mistaken for a decline", () => {
  // `onUploadError` swallows a decline silently; unavailability must reach the
  // user, so the two must never be confused for one another.
  const unavailable = new MediaUploadUnavailable("nope");
  assert.equal(unavailable instanceof MediaUploadDeclined, false);
  assert.equal(
    new MediaUploadDeclined() instanceof MediaUploadUnavailable,
    false,
  );
});
