import * as React from "react";

import {
  shouldHandoffToProvisioning,
  type CreatedAgentForHandoff,
  type ProvisioningHandoffAgent,
} from "./lib/agentProvisioningHandoff";

export type { ProvisioningHandoffAgent };

/**
 * Hand off to `AgentProvisioningDialog` (buzz#74) once a create flow's own
 * `createdAgent` transitions from set to `null` — i.e. the operator closed
 * `SecretRevealDialog` — for a successfully spawned agent.
 *
 * Shared by every entry point that mints a new managed agent so they all
 * hand off identically (buzz#122): the contextual add-bot-to-channel path
 * (`RequestedAgentCreateDialogs`) and every Agents-page create surface
 * (`AgentsView`'s "New agent" flow, duplicate-persona-and-start, and "start
 * this persona now").
 */
export function useAgentProvisioningHandoff(
  createdAgent: CreatedAgentForHandoff | null,
) {
  const [provisioningAgent, setProvisioningAgent] =
    React.useState<ProvisioningHandoffAgent | null>(null);
  const previousCreatedAgent = React.useRef(createdAgent);

  React.useEffect(() => {
    const was = previousCreatedAgent.current;
    previousCreatedAgent.current = createdAgent;
    if (was && shouldHandoffToProvisioning(was, createdAgent)) {
      setProvisioningAgent({ pubkey: was.agent.pubkey, name: was.agent.name });
    }
  }, [createdAgent]);

  return {
    provisioningAgent,
    dismissProvisioning: () => setProvisioningAgent(null),
  };
}
