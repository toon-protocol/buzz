/**
 * Whether an agent should show the "Wallet not set up" badge (buzz#122 AC2).
 *
 * Declining ("Do this later") `AgentProvisioningDialog` must leave a visible
 * indicator on the agent rather than silence — the silent-death failure the
 * agent-fleet-money epic (toon-meta#261) exists to prevent. The badge is
 * gated on TOON being the active transport (AC3 — no badge where money does
 * not exist) and disappears the moment the channel is actually confirmed,
 * even if the declined flag is still set.
 */

export type AgentProvisioningBadgeSnapshot = {
  toonActive: boolean;
  channelConfirmed: boolean;
  declined: boolean;
};

export function isAgentProvisioningUnprovisioned(
  snapshot: AgentProvisioningBadgeSnapshot,
): boolean {
  return snapshot.toonActive && snapshot.declined && !snapshot.channelConfirmed;
}
