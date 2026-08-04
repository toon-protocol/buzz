import * as React from "react";

import type { InboundFactoryJob } from "@/features/providers/lib/useInboundFactoryJobs";
import { QuoteForm } from "@/features/providers/ui/QuoteForm";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";

/**
 * Inbound job feed (buzz#84 "What" §2): open jobs matching what this agent
 * serves. Quoting is inline, not a separate screen — decision 7 means there
 * is nothing more to a quote than the schedule itself.
 */
export function InboundJobsList({
  canQuote,
  jobs,
  transport,
  onQuoted,
}: {
  /** Whether this agent's connector session is confirmed reachable — see `ProviderJobsPanel`. */
  canQuote: boolean;
  jobs: InboundFactoryJob[];
  transport: ToonEventTransport;
  onQuoted: (jobId: string) => void;
}) {
  const [expandedJobId, setExpandedJobId] = React.useState<string | null>(null);

  if (jobs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No open jobs match what this agent currently serves.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {jobs.map((job) => (
        <li key={job.eventId}>
          <Card className="p-4">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                {job.brief}
                {job.giftWrapped ? (
                  <Badge variant="secondary">private</Badge>
                ) : null}
                {job.alreadyQuoted ? (
                  <Badge variant="outline">quoted</Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 p-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>from {truncatePubkey(job.buyerPubkey)}</span>
                <span>bid up to {formatUsdcBaseUnits(job.bidBaseUnits)}</span>
                {job.repo ? <span>{job.repo}</span> : null}
              </div>
              {expandedJobId === job.eventId ? (
                <QuoteForm
                  canQuote={canQuote}
                  jobId={job.eventId}
                  onQuoted={() => {
                    setExpandedJobId(null);
                    onQuoted(job.eventId);
                  }}
                  transport={transport}
                />
              ) : (
                <button
                  className="w-fit text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                  disabled={!canQuote}
                  onClick={() => setExpandedJobId(job.eventId)}
                  type="button"
                >
                  {job.alreadyQuoted ? "Send another quote" : "Quote"}
                </button>
              )}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
