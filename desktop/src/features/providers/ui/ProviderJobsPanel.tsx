import * as React from "react";

import { providerAvailabilityCaption } from "@/features/providers/lib/providerAvailability";
import {
  getProviderCapabilitySettings,
  subscribeToProviderCapabilitySettings,
} from "@/features/providers/lib/providerCapabilitySettings";
import { useInboundFactoryJobs } from "@/features/providers/lib/useInboundFactoryJobs";
import { useProviderAvailability } from "@/features/providers/lib/useProviderAvailability";
import { ProviderCapabilityToggle } from "@/features/providers/ui/ProviderCapabilityToggle";
import { InboundJobsList } from "@/features/providers/ui/InboundJobsList";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import { Card } from "@/shared/ui/card";

/**
 * Provider surface (buzz#84): advertise a capability, see matching jobs, and
 * quote — the three pieces this ticket's own spec work (toon-meta#263)
 * leaves unblocked. Availability (the freshness invariant,
 * `providerAvailability.ts`) now has a live caller too:
 * `useProviderAvailability` reads the connector's session lease TTL off
 * `ToonPaidWriter.getSessionLease()` (toon-client#509,
 * `@toon-protocol/client@0.28.0`) rather than the coarse "is the transport
 * ready" signal this panel gated on before that TTL was reachable.
 *
 * The quote action is gated on `availability.kind !== "stale"`, deliberately
 * NOT on `canQuoteJobs` (`kind === "available"`): the lease is learned FROM a
 * successful write, so a provider agent that has never made one yet reads
 * `pending`, not `available` — gating on `canQuoteJobs` here would block
 * that agent's very first quote forever, since nothing else would ever
 * produce the write the freshness state is waiting on. `pending` therefore
 * proceeds (unknown is not the same as confirmed-unreachable); only a
 * definitely-stale session — one this code already knows cannot land a
 * write — blocks the action, matching the freshness invariant's own stated
 * asymmetry: erring toward letting a quote through costs, at worst, one
 * rejected 1 µUSDC write; erring the other way costs a legitimate provider
 * its first job.
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
  const availability = useProviderAvailability(transport, settings.enabled);
  const canQuote = availability.kind !== "stale";
  const caption = providerAvailabilityCaption(availability);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <ProviderCapabilityToggle pubkey={myPubkey} settings={settings} />
      </Card>
      {settings.enabled ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Jobs you can serve</h2>
          {caption ? (
            <p className="text-xs text-muted-foreground">{caption}</p>
          ) : null}
          <InboundJobsList
            canQuote={canQuote}
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
