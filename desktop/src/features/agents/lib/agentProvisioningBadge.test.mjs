import assert from "node:assert/strict";
import test from "node:test";

import { isAgentProvisioningUnprovisioned } from "./agentProvisioningBadge.ts";

test("shows the badge once the operator declined and the channel is still not open", () => {
  assert.equal(
    isAgentProvisioningUnprovisioned({
      toonActive: true,
      channelConfirmed: false,
      declined: true,
    }),
    true,
  );
});

test("never shows on relay transport, even if declined", () => {
  assert.equal(
    isAgentProvisioningUnprovisioned({
      toonActive: false,
      channelConfirmed: false,
      declined: true,
    }),
    false,
  );
});

test("does not show for an agent that never reached/declined the dialog", () => {
  assert.equal(
    isAgentProvisioningUnprovisioned({
      toonActive: true,
      channelConfirmed: false,
      declined: false,
    }),
    false,
  );
});

test("clears once the channel is confirmed, even if declined before", () => {
  assert.equal(
    isAgentProvisioningUnprovisioned({
      toonActive: true,
      channelConfirmed: true,
      declined: true,
    }),
    false,
  );
});
