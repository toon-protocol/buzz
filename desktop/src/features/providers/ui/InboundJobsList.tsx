import * as React from "react";

import type { InboundFactoryJob } from "@/features/providers/lib/useInboundFactoryJobs";
import { ProviderDeliveryThread } from "@/features/providers/ui/ProviderDeliveryThread";
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
  myPubkey,
  transport,
  onQuoted,
}: {
  /** Whether this agent's connector session is confirmed reachable — see `ProviderJobsPanel`. */
  canQuote: boolean;
  jobs: InboundFactoryJob[];
  myPubkey: string;
  transport: ToonEventTransport;
  onQuoted: (jobId: string) => void;
}) {
  const [expandedJobId, setExpandedJobId] = React.useState<string | null>(null);
  const [deliveringJobId, setDeliveringJobId] = React.useState<string | null>(
    null,
  );
  // `alreadyQuoted` comes from a one-shot fetch at mount, so a quote sent
  // THIS session must unlock delivery without waiting for a refetch.
  const [justQuotedJobIds, setJustQuotedJobIds] = React.useState<Set<string>>(
    new Set(),
  );

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
                  buyerPubkey={job.buyerPubkey}
                  canQuote={canQuote}
                  jobId={job.eventId}
                  onQuoted={() => {
                    setExpandedJobId(null);
                    setJustQuotedJobIds((prev) =>
                      new Set(prev).add(job.eventId),
                    );
                    onQuoted(job.eventId);
                  }}
                  transport={transport}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <button
                    className="w-fit text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                    disabled={!canQuote}
                    onClick={() => setExpandedJobId(job.eventId)}
                    type="button"
                  >
                    {job.alreadyQuoted ? "Send another quote" : "Quote"}
                  </button>
                  {job.alreadyQuoted || justQuotedJobIds.has(job.eventId) ? (
                    <button
                      className="w-fit text-xs text-primary hover:underline"
                      onClick={() =>
                        setDeliveringJobId((current) =>
                          current === job.eventId ? null : job.eventId,
                        )
                      }
                      type="button"
                    >
                      {deliveringJobId === job.eventId
                        ? "Hide delivery"
                        : "Deliver"}
                    </button>
                  ) : null}
                </div>
              )}
              {deliveringJobId === job.eventId ? (
                <ProviderDeliveryThread
                  job={job}
                  myPubkey={myPubkey}
                  transport={transport}
                />
              ) : null}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
