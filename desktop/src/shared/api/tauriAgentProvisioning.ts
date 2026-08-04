import { invokeTauri } from "@/shared/api/tauri";

/**
 * The BIP-44 account index `create_managed_agent` already assigned this
 * agent (buzz#79), or `null` if it has none yet — the provisioning flow
 * (buzz#74) needs this to derive the agent's own TOON payment address.
 *
 * Split from `tauri.ts` rather than added there — that file is already at
 * the desktop file-size ratchet ceiling, and every other binding this small
 * follows the same split (`tauriGlobalAgentConfig.ts`, `agentControl.ts`).
 */
export async function getManagedAgentAccountIndex(
  pubkey: string,
): Promise<number | null> {
  return invokeTauri<number | null>("get_managed_agent_account_index", {
    pubkey,
  });
}
