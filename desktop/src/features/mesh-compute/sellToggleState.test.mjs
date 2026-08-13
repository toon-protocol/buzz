import assert from "node:assert/strict";
import test from "node:test";

import { deriveMeshSellToggle } from "./sellToggleState.ts";

const status = (overrides = {}) => ({
  state: "off",
  mode: null,
  admission: null,
  health: { status: "ok", reason: null },
  apiBaseUrl: null,
  consoleUrl: null,
  modelId: null,
  modelName: null,
  ...overrides,
});

test("self_only serve running/starting reads as selling", () => {
  for (const state of ["running", "starting"]) {
    const model = deriveMeshSellToggle(
      status({ state, mode: "serve", admission: "self_only" }),
    );
    assert.equal(
      model.isSelling,
      true,
      `serve+self_only+${state} should be selling`,
    );
    assert.equal(model.blockedByOther, false);
    assert.equal(model.slotOccupied, true);
  }
});

test("a community (Share compute) serve node occupies the slot but is NOT selling", () => {
  for (const admission of ["community", undefined]) {
    const model = deriveMeshSellToggle(
      status({ state: "running", mode: "serve", admission }),
    );
    assert.equal(model.isSelling, false);
    assert.equal(model.blockedByOther, true);
    assert.equal(model.slotOccupied, true);
  }
});

test("a client (consuming) node occupies the slot but is NOT selling", () => {
  const model = deriveMeshSellToggle(
    status({ state: "running", mode: "client" }),
  );
  assert.equal(model.isSelling, false);
  assert.equal(model.blockedByOther, true);
  assert.equal(model.slotOccupied, true);
});

test("a FAILED self_only node still occupies the slot and stays turn-off-able", () => {
  const model = deriveMeshSellToggle(
    status({ state: "failed", mode: "serve", admission: "self_only" }),
  );
  assert.equal(
    model.isSelling,
    true,
    "failed self_only node is still turn-off-able",
  );
  assert.equal(model.blockedByOther, false);
  assert.equal(model.slotOccupied, true);
});

test("off / stopping never occupy the slot or read as selling/blocked", () => {
  for (const state of ["off", "stopping"]) {
    for (const admission of [null, "community", "self_only"]) {
      const model = deriveMeshSellToggle(
        status({ state, mode: "serve", admission }),
      );
      assert.equal(model.isSelling, false, `${admission}+${state} not selling`);
      assert.equal(
        model.blockedByOther,
        false,
        `${admission}+${state} not blocked`,
      );
      assert.equal(
        model.slotOccupied,
        false,
        `${admission}+${state} slot free`,
      );
    }
  }
});

test("null status (not yet fetched) is neither selling nor blocked", () => {
  const model = deriveMeshSellToggle(null);
  assert.equal(model.isSelling, false);
  assert.equal(model.blockedByOther, false);
  assert.equal(model.slotOccupied, false);
});

test("running with a missing mode occupies the slot but is not selling", () => {
  const model = deriveMeshSellToggle(
    status({ state: "running", mode: null, admission: "self_only" }),
  );
  assert.equal(model.isSelling, false);
  assert.equal(model.blockedByOther, true);
  assert.equal(model.slotOccupied, true);
});
