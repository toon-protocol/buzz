/**
 * Shared "did the secret-reveal step just close for a successfully spawned
 * agent" check (buzz#74/buzz#122) — every entry point on the Agents page
 * that mints a new managed agent (the "New agent" create flow, the
 * duplicate-persona-and-start flow, "start this persona now") and the
 * contextual add-bot-to-channel path all hand off to
 * `AgentProvisioningDialog` the same way: `createdAgent` transitions from
 * set to `null` once the operator dismisses `SecretRevealDialog`, and the
 * agent actually spawned (no `spawnError`) rather than failing to start.
 */

export type ProvisioningHandoffAgent = { pubkey: string; name: string };

export type CreatedAgentForHandoff = {
  agent: ProvisioningHandoffAgent;
  spawnError?: string | null;
};

export function shouldHandoffToProvisioning(
  previous: CreatedAgentForHandoff | null,
  current: CreatedAgentForHandoff | null,
): boolean {
  return previous !== null && current === null && !previous.spawnError;
}
