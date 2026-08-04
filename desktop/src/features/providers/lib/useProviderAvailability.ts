import * as React from "react";

import {
  deriveProviderAvailability,
  type ProviderAvailability,
} from "@/features/providers/lib/providerAvailability";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";

/**
 * Wires `providerAvailability.ts`'s freshness invariant (buzz#84 decision 12)
 * to its first live source: `ToonPaidWriter.getSessionLease()`, itself read
 * off `ToonClient.getLastConnectorRouteTerms()?.extra.session_lease_ttl_ms`
 * (toon-client#509, shipped in `@toon-protocol/client@0.28.0`).
 *
 * That value is only known once this session has completed a real write —
 * before the first quote goes out, and permanently against a connector
 * predating connector#722, it reads `pending`. This never substitutes a
 * literal TTL to make the gate look finished (the issue thread's explicit
 * "do not hardcode 120_000") — an unknown lease reads as "not yet
 * knowable," the same posture `providerAvailability.ts` already takes for
 * every other honestly-unavailable case.
 *
 * Re-renders on every paid write (a fresh lease reading) and on a slow tick
 * while advertising is live, so `available` degrades to `stale` once the
 * lease elapses even without a new write in between — mirrors
 * `useMeshNodeStatus.ts`'s poll-while-relevant shape.
 */
export function useProviderAvailability(
  transport: ToonEventTransport | null,
  advertisingEnabled: boolean,
): ProviderAvailability {
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);

  React.useEffect(() => {
    if (!transport) return;
    return transport.onPaidWrite(() => rerender());
  }, [transport]);

  const sessionConnected = transport?.isWritable() ?? false;

  React.useEffect(() => {
    if (!advertisingEnabled || !sessionConnected) return;
    const handle = window.setInterval(() => rerender(), 5_000);
    return () => window.clearInterval(handle);
  }, [advertisingEnabled, sessionConnected]);

  if (!advertisingEnabled) return { kind: "unadvertised" };
  if (!sessionConnected) return { kind: "stale" };

  const lease = transport?.getPaidWriter().getSessionLease();
  if (!lease) return { kind: "pending" };

  return deriveProviderAvailability({
    advertisingEnabled,
    sessionConnected,
    lastAdvertisedAtMs: lease.observedAtMs,
    nowMs: Date.now(),
    sessionLeaseTtlMs: lease.sessionLeaseTtlMs,
  });
}
