import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import { detectContentType, StoreMediaUploader } from "./storeMediaUploader.ts";
import { setArweaveGateways } from "../lib/arweaveMedia.ts";

globalThis.crypto ??= webcrypto;

const TX_ID = "hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02];

/** A `ToonPaidWriter` stand-in that records what it was asked to do. */
function fakeWriter({ fee = 1500n, txId = TX_ID, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    quoteStoreFee: async () => fee,
    uploadBlob: async (blobData, contentType) => {
      calls.push({ blobData, contentType });
      if (fail) throw new Error(fail);
      return {
        txId,
        receipt: {
          eventId: "evt",
          amount: fee,
          assetScale: 6,
          asset: "USDC",
          destination: "g.toon.ario",
        },
      };
    },
  };
}

test("content type comes from the bytes, not the extension", () => {
  // The extension is user-supplied and the bytes are not. A `.txt` that is
  // really a PNG must be declared as a PNG, or every reader mis-renders it.
  assert.equal(detectContentType(PNG, "screenshot.txt"), "image/png");
  assert.equal(detectContentType([0xff, 0xd8, 0xff, 0x00]), "image/jpeg");
});

test("an unrecognisable file falls back to its extension, then to octet-stream", () => {
  assert.equal(detectContentType([1, 2, 3, 4], "notes.pdf"), "application/pdf");
  assert.equal(detectContentType([1, 2, 3, 4]), "application/octet-stream");
  assert.equal(
    detectContentType([1, 2, 3, 4], "mystery"),
    "application/octet-stream",
  );
});

test("the quote is flat, permanent, and names the store backend", async () => {
  const uploader = new StoreMediaUploader(fakeWriter({ fee: 2000n }));
  assert.deepEqual(await uploader.quote(), {
    amount: 2000n,
    asset: "USDC",
    assetScale: 6,
    permanent: true,
    backend: "store",
  });
});

test("an upload pays the store route and returns an Arweave-addressed descriptor", async () => {
  setArweaveGateways(null);
  const writer = fakeWriter();
  const uploader = new StoreMediaUploader(writer);

  const descriptor = await uploader.upload({
    data: PNG,
    filename: "shot.png",
  });

  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].contentType, "image/png");
  assert.deepEqual([...writer.calls[0].blobData], PNG);

  assert.equal(descriptor.url, `https://ar-io.dev/${TX_ID}`);
  assert.equal(descriptor.type, "image/png");
  assert.equal(descriptor.size, PNG.length);
  assert.equal(descriptor.filename, "shot.png");
  // sha256 of the bytes, so a tombstone can name this attachment later.
  assert.match(descriptor.sha256, /^[\da-f]{64}$/);
});

test("the descriptor's primary URL follows the configured gateway preference", async () => {
  setArweaveGateways(["https://permagate.io"]);
  try {
    const uploader = new StoreMediaUploader(fakeWriter());
    const descriptor = await uploader.upload({ data: PNG });
    assert.equal(descriptor.url, `https://permagate.io/${TX_ID}`);
  } finally {
    setArweaveGateways(null);
  }
});

test("an empty upload is refused before it costs anything", async () => {
  const writer = fakeWriter();
  const uploader = new StoreMediaUploader(writer);
  await assert.rejects(() => uploader.upload({ data: [] }), /empty upload/);
  assert.equal(writer.calls.length, 0);
});

test("a refused upload surfaces the store node's reason", async () => {
  const uploader = new StoreMediaUploader(
    fakeWriter({ fail: "insufficient collateral" }),
  );
  await assert.rejects(
    () => uploader.upload({ data: PNG }),
    /insufficient collateral/,
  );
});
