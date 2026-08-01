import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  getStoredMnemonic,
  isToonChannelConfirmed,
  isToonFirstMessageSent,
  resetToonOnboardingState,
  setStoredMnemonic,
  setToonChannelConfirmed,
  setToonFirstMessageSent,
  setToonOnboardingStorage,
  subscribeToToonOnboardingState,
} from "./toonOnboardingStore.ts";

const MNEMONIC = "test test test test test test test test test test test junk";

/** A disk that survives a "restart" — the store's cache does not. */
function fakeDisk(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

let disk;

beforeEach(() => {
  disk = fakeDisk();
  setToonOnboardingStorage(disk);
});

test("a fresh store has no wallet and no flags", () => {
  assert.equal(getStoredMnemonic(), null);
  assert.equal(isToonChannelConfirmed(), false);
  assert.equal(isToonFirstMessageSent(), false);
});

test("a stored mnemonic survives a restart", () => {
  setStoredMnemonic(MNEMONIC);

  // Same disk, empty cache — what relaunching the app does.
  setToonOnboardingStorage(disk);

  assert.equal(getStoredMnemonic(), MNEMONIC);
});

test("the channel and first-message flags persist independently", () => {
  setStoredMnemonic(MNEMONIC);
  setToonChannelConfirmed(true);

  setToonOnboardingStorage(disk);
  assert.equal(isToonChannelConfirmed(), true);
  assert.equal(isToonFirstMessageSent(), false);

  setToonFirstMessageSent(true);
  setToonOnboardingStorage(disk);
  assert.equal(isToonChannelConfirmed(), true);
  assert.equal(isToonFirstMessageSent(), true);
});

test("clearing the mnemonic does not clear the flags", () => {
  setStoredMnemonic(MNEMONIC);
  setToonChannelConfirmed(true);
  setStoredMnemonic(null);

  setToonOnboardingStorage(disk);
  assert.equal(getStoredMnemonic(), null);
  assert.equal(isToonChannelConfirmed(), true);
});

test("resetting clears everything from disk", () => {
  setStoredMnemonic(MNEMONIC);
  setToonChannelConfirmed(true);
  setToonFirstMessageSent(true);

  resetToonOnboardingState();
  setToonOnboardingStorage(disk);

  assert.equal(getStoredMnemonic(), null);
  assert.equal(isToonChannelConfirmed(), false);
  assert.equal(isToonFirstMessageSent(), false);
  assert.equal(disk.values.size, 0);
});

test("a corrupted record is dropped rather than partially trusted", () => {
  disk.setItem("buzz-toon-onboarding.v1", "{not json");
  setToonOnboardingStorage(disk);

  assert.equal(getStoredMnemonic(), null);
  assert.equal(isToonChannelConfirmed(), false);
});

test("subscribers hear about every change", () => {
  let notifications = 0;
  const unsubscribe = subscribeToToonOnboardingState(() => {
    notifications += 1;
  });

  setStoredMnemonic(MNEMONIC);
  setToonChannelConfirmed(true);
  setToonFirstMessageSent(true);
  resetToonOnboardingState();

  assert.equal(notifications, 4);
  unsubscribe();

  setStoredMnemonic(MNEMONIC);
  assert.equal(notifications, 4);
});
