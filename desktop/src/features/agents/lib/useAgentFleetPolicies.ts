import { useAutoRestartPolicy } from "@/features/agents/lib/useAutoRestartPolicy";
import { useAgentAutoRefillPolicy } from "@/features/agents/lib/useAgentAutoRefillPolicy";

/**
 * Mounts the app-shell-level agent policy loops: Chunk F auto-restart
 * (drifted idle agents, per-agent opt-out, default ON) and buzz#132's
 * opt-in auto-refill (hard monthly ceiling, off by default). Grouped into
 * one hook so `AppShell.tsx` has a single mount point for both — it is
 * already at the desktop file-size ceiling (`just desktop-check`'s
 * `check:file-sizes` ratchet), so new always-on, UI-less policy loops
 * belong here rather than as additional top-level calls there.
 */
export function useAgentFleetPolicies(): void {
  useAutoRestartPolicy();
  useAgentAutoRefillPolicy();
}
