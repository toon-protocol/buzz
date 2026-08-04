import * as React from "react";

import { CompareQuotes } from "@/features/factory-jobs/ui/CompareQuotes";
import { FactoryJobThread } from "@/features/factory-jobs/ui/FactoryJobThread";
import { PostJobForm } from "@/features/factory-jobs/ui/PostJobForm";
import {
  factoryJobAvailabilityCaption,
  useFactoryJobAvailability,
} from "@/features/factory-jobs/lib/factoryJobAvailability";
import type { FactoryJobIncrementOffer } from "@/features/factory-jobs/lib/factoryJobFeedback";
import {
  useFactoryJobFeedback,
  useOwnFactoryJobs,
  useProviderJobHistory,
} from "@/features/factory-jobs/lib/useFactoryJobBuyer";
import { compareFactoryJobQuotes } from "@/features/factory-jobs/lib/factoryJobQuoteCompare";
import { ProviderJobsPanel } from "@/features/providers/ui/ProviderJobsPanel";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

/**
 * Buyer surface (buzz#85): post a job, compare quotes, pay increment by
 * increment. TOON-only — the factory job market has no relay-transport
 * fallback (see `factoryJobAvailability.ts`).
 */

function JobDetail({
  jobId,
  bidBaseUnits,
}: {
  jobId: string;
  bidBaseUnits: bigint;
}) {
  const availability = useFactoryJobAvailability();
  const transport =
    availability.kind === "ready" ? availability.transport : null;
  const { quotes, offersByProvider, narrationByProvider } =
    useFactoryJobFeedback(transport, jobId);

  const providerPubkeys = React.useMemo(
    () => [...new Set(quotes.map((quote) => quote.providerPubkey))],
    [quotes],
  );
  const completedByProvider = useProviderJobHistory(transport, providerPubkeys);

  const reputationByPubkey = React.useMemo(() => {
    const map = new Map<
      string,
      { jobsCompleted: number; gatePassRate: number | null }
    >();
    for (const [pubkey, jobsCompleted] of completedByProvider) {
      // Gate-pass rate has no wire signal yet — see `useFactoryJobBuyer.ts`.
      map.set(pubkey, { jobsCompleted, gatePassRate: null });
    }
    return map;
  }, [completedByProvider]);

  const comparison = React.useMemo(
    () => compareFactoryJobQuotes(quotes, bidBaseUnits, reputationByPubkey),
    [quotes, bidBaseUnits, reputationByPubkey],
  );

  const [selectedProviderPubkey, setSelectedProviderPubkey] = React.useState<
    string | null
  >(null);
  const [paidIncrementNumbers, setPaidIncrementNumbers] = React.useState<
    Set<number>
  >(new Set());
  const [fulfillmentByIncrement, setFulfillmentByIncrement] = React.useState<
    Map<number, string>
  >(new Map());
  const [payingIncrementNumber, setPayingIncrementNumber] = React.useState<
    number | null
  >(null);
  const [payError, setPayError] = React.useState<string | null>(null);

  const selectedQuote = React.useMemo(
    () =>
      selectedProviderPubkey
        ? quotes.find(
            (quote) => quote.providerPubkey === selectedProviderPubkey,
          )
        : undefined,
    [quotes, selectedProviderPubkey],
  );

  const handleSelectProvider = (providerPubkey: string) => {
    setSelectedProviderPubkey(providerPubkey);
    setPaidIncrementNumbers(new Set());
    setFulfillmentByIncrement(new Map());
    setPayError(null);
  };

  const handlePayIncrement = async (offer: FactoryJobIncrementOffer) => {
    if (!transport) return;
    setPayingIncrementNumber(offer.increment.n);
    setPayError(null);
    try {
      const receipt = await transport.getPaidWriter().payFactoryJobIncrement({
        destination: offer.providerPubkey,
        amountBaseUnits: offer.amountBaseUnits,
        conditionHex: offer.conditionHex,
        jobEventId: offer.eventId,
      });
      setPaidIncrementNumbers((prev) => new Set(prev).add(offer.increment.n));
      setFulfillmentByIncrement((prev) =>
        new Map(prev).set(offer.increment.n, receipt.fulfillmentHex),
      );
    } catch (error) {
      setPayError(
        error instanceof Error
          ? error.message
          : "Failed to pay this increment.",
      );
    } finally {
      setPayingIncrementNumber(null);
    }
  };

  if (availability.kind !== "ready") {
    return (
      <p className="text-sm text-muted-foreground">
        {factoryJobAvailabilityCaption(availability)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CompareQuotes
        comparison={comparison}
        onSelectProvider={handleSelectProvider}
        selectedProviderPubkey={selectedProviderPubkey}
      />
      {selectedProviderPubkey && selectedQuote ? (
        <FactoryJobThread
          fulfillmentByIncrement={fulfillmentByIncrement}
          narration={narrationByProvider.get(selectedProviderPubkey) ?? []}
          offers={offersByProvider.get(selectedProviderPubkey) ?? []}
          onPayIncrement={(offer) => void handlePayIncrement(offer)}
          paidIncrementNumbers={paidIncrementNumbers}
          payError={payError}
          payingIncrementNumber={payingIncrementNumber}
          schedule={selectedQuote.increments}
        />
      ) : null}
    </div>
  );
}

/** Buying (post a job) or providing (serve open jobs) — buzz#84 adds the second half. */
type JobsScreenMode = "buy" | "provide";

export function FactoryJobsScreen() {
  const availability = useFactoryJobAvailability();
  const transport =
    availability.kind === "ready" ? availability.transport : null;
  const identityQuery = useIdentityQuery();
  const myPubkey = identityQuery.data?.pubkey ?? null;
  const ownJobs = useOwnFactoryJobs(transport, myPubkey);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<JobsScreenMode>("buy");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          {mode === "buy"
            ? "Post a job, compare quotes, and pay each increment as it delivers — you can stop at any boundary, having risked at most one."
            : "Advertise this agent as a provider, see open jobs it can serve, and quote — acceptance is payment of increment 1, so there is no separate accept step."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          onClick={() => setMode("buy")}
          size="sm"
          variant={mode === "buy" ? "default" : "outline"}
        >
          Buying
        </Button>
        <Button
          onClick={() => setMode("provide")}
          size="sm"
          variant={mode === "provide" ? "default" : "outline"}
        >
          Providing
        </Button>
      </div>
      {renderJobsScreenBody({
        availability,
        mode,
        myPubkey,
        ownJobs,
        selectedJobId,
        setSelectedJobId,
      })}
    </div>
  );
}

function renderJobsScreenBody({
  availability,
  mode,
  myPubkey,
  ownJobs,
  selectedJobId,
  setSelectedJobId,
}: {
  availability: ReturnType<typeof useFactoryJobAvailability>;
  mode: JobsScreenMode;
  myPubkey: string | null;
  ownJobs: ReturnType<typeof useOwnFactoryJobs>;
  selectedJobId: string | null;
  setSelectedJobId: (jobId: string) => void;
}) {
  if (availability.kind !== "ready") {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        {factoryJobAvailabilityCaption(availability)}
      </Card>
    );
  }

  if (mode === "provide") {
    return myPubkey ? (
      <ProviderJobsPanel
        myPubkey={myPubkey}
        transport={availability.transport}
      />
    ) : null;
  }

  return (
    <>
      <Card className="p-4">
        <PostJobForm
          onPosted={(event) => setSelectedJobId(event.id)}
          transport={availability.transport}
        />
      </Card>
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Your jobs</h2>
        {ownJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing posted yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {ownJobs.map((job) => (
              <li key={job.eventId}>
                <button
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted/50 ${
                    job.eventId === selectedJobId
                      ? "border-primary"
                      : "border-transparent"
                  }`}
                  onClick={() => setSelectedJobId(job.eventId)}
                  type="button"
                >
                  <span className="font-medium">{job.brief}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    bid up to {formatUsdcBaseUnits(job.bidBaseUnits)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selectedJobId ? (
        <JobDetail
          // Remount on job switch: `JobDetail` holds per-job payment
          // state (selected provider, paid increments) that must never
          // carry over to a different job.
          key={selectedJobId}
          bidBaseUnits={
            ownJobs.find((job) => job.eventId === selectedJobId)
              ?.bidBaseUnits ?? 0n
          }
          jobId={selectedJobId}
        />
      ) : null}
    </>
  );
}
