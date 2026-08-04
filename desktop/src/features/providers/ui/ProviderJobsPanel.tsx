import * as React from "react";

import {
  getProviderCapabilitySettings,
  subscribeToProviderCapabilitySettings,
} from "@/features/providers/lib/providerCapabilitySettings";
import { useInboundFactoryJobs } from "@/features/providers/lib/useInboundFactoryJobs";
import { ProviderCapabilityToggle } from "@/features/providers/ui/ProviderCapabilityToggle";
import { InboundJobsList } from "@/features/providers/ui/InboundJobsList";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import { Card } from "@/shared/ui/card";

/**
 * Provider surface (buzz#84): advertise a capability, see matching jobs, and
 * quote — the three pieces this ticket's own spec work (toon-meta#263)
 * leaves unblocked today. Availability (the freshness invariant) shipped
 * separately in `providerAvailability.ts` and still has no live caller: it
 * needs the connector's session lease TTL, which no published
 * `@toon-protocol/client`/`@toon-protocol/connector` release exposes yet
 * (buzz#84's own issue thread, checked again against 0.26.1 — still absent).
 * This panel therefore gates quoting on the transport actually being ready
 * (`useFactoryJobAvailability`, the same coarse signal the buyer surface
 * already relies on) rather than the finer, still-unwireable lease window.
 */
export function ProviderJobsPanel({
  transport,
  myPubkey,
}: {
  transport: ToonEventTransport;
  myPubkey: string;
}) {
  const settings = React.useSyncExternalStore(
    subscribeToProviderCapabilitySettings,
    () => getProviderCapabilitySettings(myPubkey),
  );
  const [quotedCount, setQuotedCount] = React.useState(0);

  const jobs = useInboundFactoryJobs(transport, myPubkey, settings);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <ProviderCapabilityToggle pubkey={myPubkey} settings={settings} />
      </Card>
      {settings.enabled ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Jobs you can serve</h2>
          <InboundJobsList
            jobs={jobs}
            onQuoted={() => setQuotedCount((count) => count + 1)}
            transport={transport}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Turn advertising on above to see open jobs matching what this agent
          serves.
        </p>
      )}
      {quotedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {quotedCount} quote{quotedCount === 1 ? "" : "s"} sent this session.
        </p>
      ) : null}
    </div>
  );
}
