import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowSidebarLowFundsCard } from "./sidebarLowFundsCardVisibility.ts";

test("hidden when no agent needs attention", () => {
  assert.equal(shouldShowSidebarLowFundsCard(0, null), false);
});

test("shown the first time an agent needs attention", () => {
  assert.equal(shouldShowSidebarLowFundsCard(1, null), true);
});

test("stays dismissed while the count does not exceed the dismissed watermark", () => {
  assert.equal(shouldShowSidebarLowFundsCard(2, 2), false);
  assert.equal(shouldShowSidebarLowFundsCard(1, 2), false);
});

test("reappears once a new agent pushes the count past the dismissed watermark", () => {
  assert.equal(shouldShowSidebarLowFundsCard(3, 2), true);
});
