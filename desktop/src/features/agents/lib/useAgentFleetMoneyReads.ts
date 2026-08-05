import * as React from "react";

import {
  readAgentsNetworkFlowStatus,
  type AgentAccountRef,
} from "@/features/profile/lib/agentClaimStateRead";
import { getManagedAgentAccountIndex } from "@/shared/api/tauriAgentProvisioning";
import type { RawNetworkFlowStatus } from "@/shared/api/toonPaidWriter";
import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";
import { getActiveTransportSelection } from "@/shared/api/transportSelection";

/**
 * One batched, no-daemon claim-state read (buzz#109 / `docs/adr/0007`)
 * covering every pubkey in `pubkeys` — resolves each agent's account index
 * (local Tauri lookups, run concurrently — buzz#79's registry has no
 * batch-lookup command, only per-pubkey) then issues a SINGLE
 * `readAgentsNetworkFlowStatus` call for the whole set, so N agents in the
 * fleet never cost N connector requests (the AC this hook exists to meet).
 *
 * Callers pass only NON-`isSelf` pubkeys: the identity this desktop process
 * itself pays as already has a faster, richer read
 * (`useNetworkSpend`'s live-writer path, with a local-watermark fallback) —
 * see `useAgentFleetStatus.ts`, this hook's only caller.
 */
export function useAgentFleetMoneyReads(
  pubkeys: readonly string[],
): ReadonlyMap<string, RawNetworkFlowStatus | null> {
  const selection = getActiveTransportSelection();
  const isToon = selection?.mode === "toon";
  const config = selection?.config ?? null;
  // A primitive dependency key, not `pubkeys` itself: the caller rebuilds
  // that array every render (it is filtered from `agents` fresh each time),
  // and an array of identical content in a fresh reference must not
  // re-trigger the effect (CONTRIBUTING.md's React-perf gotcha).
  const pubkeysKey = pubkeys.join(",");

  const [raw, setRaw] = React.useState<
    ReadonlyMap<string, RawNetworkFlowStatus | null>
  >(new Map());

  React.useEffect(() => {
    // Rebuilt from the primitive `pubkeysKey` dependency rather than closing
    // over the `pubkeys` prop directly — an array of identical content in a
    // fresh reference must not re-trigger this effect (see `pubkeysKey`'s
    // own doc above).
    const keys = pubkeysKey === "" ? [] : pubkeysKey.split(",");
    if (!isToon || config === null || keys.length === 0) {
      setRaw(new Map());
      return;
    }
    let cancelled = false;
    void readFleetStatus(config, keys)
      .then((results) => {
        if (!cancelled) setRaw(results);
      })
      .catch((error: unknown) => {
        console.error("[agent-fleet] batched claim-state read failed", error);
        if (!cancelled) setRaw(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [isToon, config, pubkeysKey]);

  return raw;
}

async function readFleetStatus(
  config: ToonTransportConfig,
  pubkeys: readonly string[],
): Promise<Map<string, RawNetworkFlowStatus | null>> {
  const resolved = await Promise.all(
    pubkeys.map(async (pubkey): Promise<AgentAccountRef | null> => {
      const accountIndex = await getManagedAgentAccountIndex(pubkey);
      return accountIndex === null ? null : { pubkey, accountIndex };
    }),
  );
  const refs = resolved.filter((ref): ref is AgentAccountRef => ref !== null);

  const results = await readAgentsNetworkFlowStatus(config, refs);
  // Every requested pubkey gets an entry — including one with no assigned
  // account index yet, which `readAgentsNetworkFlowStatus` never sees and so
  // never populates. `null` there reads as `unavailable`, same as any other
  // agent this batch could not verify.
  for (const pubkey of pubkeys) {
    if (!results.has(pubkey)) results.set(pubkey, null);
  }
  return results;
}
