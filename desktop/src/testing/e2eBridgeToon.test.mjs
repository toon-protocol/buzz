/**
 * Unit tests for the e2e bridge's fake TOON payment client (buzz#131).
 *
 * Imported directly from the extracted e2eBridgeToon.ts module — no Tauri
 * mock or browser environment needed — to prove:
 *
 *  1. the "funded" fixture reports a healthy deposit/claimed spread
 *  2. the "low-runway" fixture reports a near-exhausted spread
 *  3. the "stale-lease" fixture reports `ok: false, error: "expired"`
 *  4. the "depleted" fixture (buzz#133) reports a zero-spendable spread
 *  5. the fixture getter is read at CALL time, not captured once
 *  6. the fake client never touches real network state (start/openChannel
 *     resolve immediately with canned values)
 *  7. the fake socket factory fires "open" without a real WebSocket
 *  8. seeding a burn-rate receipt (buzz#133) is visible to the live spend
 *     store's snapshot
 *  9. `getLastConnectorRouteTerms` answers `undefined` by default and a
 *     seeded TTL once configured (buzz#134 AC3)
 * 10. the fake socket answers a `REQ` from seeded fixture events, filtered
 *     by kind/author/tag, followed by an `EOSE` (buzz#134 AC1)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getNetworkSpendLiveSnapshot,
  resetNetworkSpendLiveStore,
} from "@/features/profile/lib/networkSpendLiveStore";

import {
  createE2eToonPaidClient,
  createE2eToonSocketFactory,
  MOCK_TOON_CHANNEL_ID,
  seedMockNetworkBurnRateReceipt,
} from "./e2eBridgeToon.ts";

describe("createE2eToonPaidClient", () => {
  it("funded fixture reports a healthy deposit/claimed spread", async () => {
    const factory = createE2eToonPaidClient(() => "funded");
    const client = await factory({});
    const [result] = await client.getClaimState([MOCK_TOON_CHANNEL_ID]);

    assert.equal(result.ok, true);
    assert.equal(result.depositTotal, "10000000");
    assert.equal(result.cumulativeClaimed, "50000");
  });

  it("low-runway fixture reports a near-exhausted spread", async () => {
    const factory = createE2eToonPaidClient(() => "low-runway");
    const client = await factory({});
    const [result] = await client.getClaimState([MOCK_TOON_CHANNEL_ID]);

    assert.equal(result.ok, true);
    assert.equal(result.depositTotal, "1000000");
    assert.equal(result.cumulativeClaimed, "990000");
  });

  it("depleted fixture reports a zero-spendable deposit/claimed spread", async () => {
    const factory = createE2eToonPaidClient(() => "depleted");
    const client = await factory({});
    const [result] = await client.getClaimState([MOCK_TOON_CHANNEL_ID]);

    assert.equal(result.ok, true);
    assert.equal(result.depositTotal, "500000");
    assert.equal(result.cumulativeClaimed, "500000");
  });

  it("stale-lease fixture reports an expired claim", async () => {
    const factory = createE2eToonPaidClient(() => "stale-lease");
    const client = await factory({});
    const [result] = await client.getClaimState([MOCK_TOON_CHANNEL_ID]);

    assert.equal(result.ok, false);
    assert.equal(result.error, "expired");
  });

  it("reads the fixture live, not captured once", async () => {
    let fixture = "funded";
    const factory = createE2eToonPaidClient(() => fixture);
    const client = await factory({});

    const [first] = await client.getClaimState([MOCK_TOON_CHANNEL_ID]);
    assert.equal(first.depositTotal, "10000000");

    fixture = "low-runway";
    const [second] = await client.getClaimState([MOCK_TOON_CHANNEL_ID]);
    assert.equal(second.depositTotal, "1000000");
  });

  it("defaults to funded when the fixture getter returns undefined", async () => {
    const factory = createE2eToonPaidClient(() => undefined);
    const client = await factory({});
    const [result] = await client.getClaimState([MOCK_TOON_CHANNEL_ID]);

    assert.equal(result.ok, true);
    assert.equal(result.depositTotal, "10000000");
  });

  it("start/openChannel resolve immediately with canned values, no network", async () => {
    const factory = createE2eToonPaidClient(() => "funded");
    const client = await factory({});

    await assert.doesNotReject(client.start());
    const channelId = await client.openChannel("g.toon.relay");
    assert.equal(channelId, MOCK_TOON_CHANNEL_ID);
  });

  it("getLastConnectorRouteTerms answers undefined with no TTL fixture (default)", async () => {
    const factory = createE2eToonPaidClient(() => "funded");
    const client = await factory({});

    assert.equal(client.getLastConnectorRouteTerms(), undefined);
  });

  it("getLastConnectorRouteTerms carries a seeded TTL, read live", async () => {
    let ttlMs = 60_000;
    const factory = createE2eToonPaidClient(
      () => "funded",
      () => ttlMs,
    );
    const client = await factory({});

    assert.deepEqual(client.getLastConnectorRouteTerms(), {
      extra: { session_lease_ttl_ms: 60_000 },
    });

    ttlMs = 0;
    assert.deepEqual(client.getLastConnectorRouteTerms(), {
      extra: { session_lease_ttl_ms: 0 },
    });
  });
});

describe("seedMockNetworkBurnRateReceipt", () => {
  it("records a receipt the live spend store's snapshot reflects", () => {
    // The store is module-level state — start from empty so the rate below
    // is this seed's alone.
    resetNetworkSpendLiveStore();
    seedMockNetworkBurnRateReceipt(17n);
    const snapshot = getNetworkSpendLiveSnapshot();

    assert.equal(snapshot.hasSample, true);
    // 17 base units over the tracker's fixed 300s trailing window.
    assert.equal(snapshot.burnRateBaseUnitsPerSec, 17 / 300);
  });
});

describe("createE2eToonSocketFactory", () => {
  it("fires the open listener without a real WebSocket", async () => {
    const factory = createE2eToonSocketFactory();
    const socket = factory("wss://example.invalid");

    const opened = new Promise((resolve) => {
      socket.addEventListener("open", resolve);
    });

    await opened;
    // A REQ against an empty (default) seed list is still answered, just
    // with nothing but EOSE — see the module doc.
    assert.doesNotThrow(() => socket.send("hello"));
    assert.doesNotThrow(() => socket.close());
  });

  function collectFrames(socket) {
    const frames = [];
    let resolveDelivered;
    const delivered = new Promise((resolve) => {
      resolveDelivered = resolve;
    });
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      frames.push(frame);
      if (frame[0] === "EOSE") resolveDelivered();
    });
    return { frames, delivered };
  }

  it("answers a REQ from seeded events filtered by kind, then EOSE", async () => {
    const matching = {
      id: "evt-1",
      pubkey: "aaaa",
      created_at: 1,
      kind: 5097,
      content: "",
      tags: [],
      sig: "",
    };
    const otherKind = { ...matching, id: "evt-2", kind: 9 };
    const factory = createE2eToonSocketFactory(() => [matching, otherKind]);
    const socket = factory("wss://example.invalid");
    const { frames, delivered } = collectFrames(socket);

    socket.send(JSON.stringify(["REQ", "sub-1", { kinds: [5097], limit: 10 }]));
    await delivered;

    assert.deepEqual(frames, [
      ["EVENT", "sub-1", matching],
      ["EOSE", "sub-1"],
    ]);
  });

  it("filters seeded events by a #e tag filter", async () => {
    const tagged = {
      id: "evt-3",
      pubkey: "aaaa",
      created_at: 1,
      kind: 7000,
      content: "",
      tags: [["e", "root-job", "", "root"]],
      sig: "",
    };
    const untagged = { ...tagged, id: "evt-4", tags: [] };
    const factory = createE2eToonSocketFactory(() => [tagged, untagged]);
    const socket = factory("wss://example.invalid");
    const { frames, delivered } = collectFrames(socket);

    socket.send(
      JSON.stringify([
        "REQ",
        "sub-2",
        { kinds: [7000], "#e": ["root-job"], limit: 10 },
      ]),
    );
    await delivered;

    assert.deepEqual(frames, [
      ["EVENT", "sub-2", tagged],
      ["EOSE", "sub-2"],
    ]);
  });

  it("answers only EOSE when no seeded event matches", async () => {
    const factory = createE2eToonSocketFactory(() => []);
    const socket = factory("wss://example.invalid");
    const { frames, delivered } = collectFrames(socket);

    socket.send(JSON.stringify(["REQ", "sub-3", { kinds: [5097], limit: 10 }]));
    await delivered;

    assert.deepEqual(frames, [["EOSE", "sub-3"]]);
  });
});
