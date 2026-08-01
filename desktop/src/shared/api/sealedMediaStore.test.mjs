import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import { encryptChannelMedia } from "./channelMediaCrypto.ts";
import { setChannelKey, setChannelKeyStorage } from "./channelKeyStore.ts";
import { fetchSealedMediaBytes, openSealedMedia } from "./sealedMediaStore.ts";
import { setArweaveGateways } from "../lib/arweaveMedia.ts";

globalThis.crypto ??= webcrypto;

const TX_ID = "hR1kmVIiK4WsRLwGwfCLl1WPdEVGGKtRr8YbQXsq8Xk";
const CHANNEL = "11111111-2222-3333-4444-555555555555";

function memoryKeys(key) {
  const values = new Map();
  setChannelKeyStorage({
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
  });
  if (key) setChannelKey(CHANNEL, key);
}

/** A `fetch` stand-in over a map of URL → bytes, recording what it was asked. */
function fakeFetch(responses) {
  const asked = [];
  const impl = async (url) => {
    asked.push(url);
    const bytes = responses[url];
    if (!bytes)
      return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(0),
    };
  };
  impl.asked = asked;
  return impl;
}

test("a member fetches the ciphertext and gets the file back", async (t) => {
  t.after(() => {
    setChannelKeyStorage(null);
    setArweaveGateways(null);
  });
  setArweaveGateways(["https://arweave.net", "https://permagate.io"]);
  const channelKey = new Uint8Array(32).fill(11);
  memoryKeys(channelKey);

  const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
  const { ciphertext, envelope } = await encryptChannelMedia(
    plaintext,
    channelKey,
    { mime: "image/png" },
  );

  const url = `https://arweave.net/${TX_ID}`;
  const opened = await openSealedMedia(
    url,
    envelope,
    CHANNEL,
    fakeFetch({ [url]: ciphertext }),
  );
  assert.deepEqual(opened, plaintext);
});

test("a non-member fetches the same bytes and gets nothing", async (t) => {
  // The acceptance criterion, at the seam that decides it: the ciphertext is
  // public, so a non-member's fetch succeeds — and their decrypt does not.
  t.after(() => {
    setChannelKeyStorage(null);
    setArweaveGateways(null);
  });
  setArweaveGateways(["https://arweave.net"]);

  const { ciphertext, envelope } = await encryptChannelMedia(
    new Uint8Array([1, 2, 3]),
    new Uint8Array(32).fill(11),
    { mime: "image/png" },
  );

  memoryKeys(new Uint8Array(32).fill(99));
  const url = `https://arweave.net/${TX_ID}`;
  assert.equal(
    await openSealedMedia(
      url,
      envelope,
      CHANNEL,
      fakeFetch({ [url]: ciphertext }),
    ),
    null,
  );

  // And a client with no key for the channel at all.
  memoryKeys(null);
  assert.equal(
    await openSealedMedia(
      url,
      envelope,
      CHANNEL,
      fakeFetch({ [url]: ciphertext }),
    ),
    null,
  );
});

test("a dead gateway is retried against its mirrors", async (t) => {
  t.after(() => setArweaveGateways(null));
  setArweaveGateways(["https://ar-io.dev", "https://arweave.net"]);

  const bytes = new Uint8Array([7, 7, 7]);
  const fetchImpl = fakeFetch({ [`https://arweave.net/${TX_ID}`]: bytes });
  const fetched = await fetchSealedMediaBytes(
    `https://ar-io.dev/${TX_ID}`,
    fetchImpl,
  );

  assert.deepEqual(fetched, bytes);
  assert.deepEqual(fetchImpl.asked, [
    `https://ar-io.dev/${TX_ID}`,
    `https://arweave.net/${TX_ID}`,
  ]);
});

test("every gateway refusing is null, not a throw", async (t) => {
  t.after(() => setArweaveGateways(null));
  setArweaveGateways(["https://ar-io.dev", "https://arweave.net"]);
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  assert.equal(
    await fetchSealedMediaBytes(`https://ar-io.dev/${TX_ID}`, fetchImpl),
    null,
  );
});
