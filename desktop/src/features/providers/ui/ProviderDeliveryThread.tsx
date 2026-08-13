import * as React from "react";

import type { FactoryJobIncrementOffer } from "@/features/factory-jobs/lib/factoryJobFeedback";
import type { FactoryJobResult } from "@/features/factory-jobs/lib/factoryJobResult";
import {
  useFactoryJobFeedback,
  useFactoryJobResults,
} from "@/features/factory-jobs/lib/useFactoryJobBuyer";
import {
  mergeOwnNarration,
  type ProviderNarrationEntry,
} from "@/features/providers/lib/providerNarrationFeed";
import type { InboundFactoryJob } from "@/features/providers/lib/useInboundFactoryJobs";
import {
  type ProviderDeliveryPhase,
  useProviderDelivery,
} from "@/features/providers/lib/useProviderDelivery";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";

/**
 * The provider's side of a hired job's thread (buzz#135) — the counterpart
 * of the buyer's `FactoryJobThread`. Offers and results read the SAME wire
 * through the SAME parsers (`useFactoryJobFeedback` / `useFactoryJobResults`):
 * a money-bearing delivery that would not render for the buyer does not
 * render here either.
 *
 * The one exception is the provider's OWN narration (owner decision
 * 2026-08-12): an author sees their own free update immediately, before the
 * relay round-trip, and the optimistic entry reconciles against the echo by
 * event id — see `providerNarrationFeed.ts`. Nothing else is speculative.
 *
 * Delivery controls are gated on the transport's BTP session
 * (`ToonPaidWriter.supportsJobDelivery`): key release rides the provider's
 * own session, so an HTTP-only transport shows the reason instead of a
 * Deliver button that could only ever strand an offer unreleasable.
 */

type ThreadItem = { key: string; createdAt: number } & (
  | { feedKind: "narration"; entry: ProviderNarrationEntry }
  | { feedKind: "offer"; entry: FactoryJobIncrementOffer }
);

export function ProviderDeliveryThread({
  job,
  myPubkey,
  transport,
}: {
  job: InboundFactoryJob;
  myPubkey: string;
  transport: ToonEventTransport;
}) {
  const supportsDelivery = transport.getPaidWriter().supportsJobDelivery();
  const { quotes, offersByProvider, narrationByProvider } =
    useFactoryJobFeedback(transport, job.eventId);
  const results = useFactoryJobResults(transport, job.eventId);

  const ownQuote = React.useMemo(
    () =>
      quotes.filter((quote) => quote.providerPubkey === myPubkey).at(-1) ??
      null,
    [quotes, myPubkey],
  );
  const ownOffers = React.useMemo(
    () => offersByProvider.get(myPubkey) ?? [],
    [offersByProvider, myPubkey],
  );
  const ownNarration = React.useMemo(
    () => narrationByProvider.get(myPubkey) ?? [],
    [narrationByProvider, myPubkey],
  );
  const ownResult =
    results.find((result) => result.providerPubkey === myPubkey) ?? null;

  const delivery = useProviderDelivery({
    transport,
    job,
    quote: ownQuote,
    wireOffers: ownOffers,
  });

  const [artifactText, setArtifactText] = React.useState("");
  const [updateText, setUpdateText] = React.useState("");

  const narrationFeed = React.useMemo(
    () => mergeOwnNarration(ownNarration, delivery.localNarration),
    [ownNarration, delivery.localNarration],
  );

  const feed: ThreadItem[] = React.useMemo(
    () =>
      [
        ...narrationFeed.map((entry) => ({
          feedKind: "narration" as const,
          key: entry.key,
          entry,
          createdAt: entry.createdAt,
        })),
        ...ownOffers.map((entry) => ({
          feedKind: "offer" as const,
          key: entry.eventId,
          entry,
          createdAt: entry.createdAt,
        })),
      ].sort((a, b) => a.createdAt - b.createdAt),
    [narrationFeed, ownOffers],
  );

  if (!ownQuote) {
    return (
      <p className="text-sm text-muted-foreground">
        Quote this job first — delivery starts on your quoted schedule, and
        acceptance is the buyer paying increment 1.
      </p>
    );
  }

  const terminal =
    ownResult !== null ||
    delivery.phase.kind === "completed" ||
    delivery.phase.kind === "abandoned-buyer";

  function renderDeliveryControls() {
    if (!supportsDelivery) {
      return (
        <p className="text-sm text-muted-foreground">
          Increment delivery needs the connector's BTP session — this transport
          is running one-shot HTTP, so this agent can quote but not deliver.
        </p>
      );
    }
    if (delivery.phase.kind === "delivering") {
      return (
        <p className="text-sm text-muted-foreground">
          Delivering increment {delivery.phase.n} — encrypting the artifact and
          uploading the ciphertext…
        </p>
      );
    }
    if (delivery.phase.kind === "awaiting-payment") {
      return (
        <Card className="flex items-center gap-2 border-primary/30 bg-primary/5 p-3 text-sm">
          <Badge variant="secondary">Waiting for buyer payment</Badge>
          <span>
            The artifact key releases only as the payment's own fulfillment —
            increment {delivery.phase.n} unlocks when the buyer pays it.
          </span>
        </Card>
      );
    }
    if (delivery.phase.kind !== "idle" || !delivery.nextIncrement) return null;

    const next = delivery.nextIncrement;
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!artifactText.trim()) return;
          void delivery.deliverNext(artifactText).then(() => {
            setArtifactText("");
          });
        }}
      >
        <Input
          aria-label={`Increment ${next.n} artifact`}
          onChange={(event) => setArtifactText(event.target.value)}
          placeholder={`Increment ${next.n} (${next.milestone}) deliverable — encrypted before anything leaves this machine`}
          value={artifactText}
        />
        <Button
          className="w-fit"
          disabled={!artifactText.trim()}
          size="sm"
          type="submit"
        >
          Deliver increment {next.n} for{" "}
          {formatUsdcBaseUnits(next.priceUsdcBaseUnits)}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {feed.map((item) => (
          <li key={item.key}>
            {item.feedKind === "narration" ? (
              renderNarration(item.entry)
            ) : (
              <Card className="flex items-center justify-between p-3">
                <span className="text-sm font-medium">
                  Increment {item.entry.increment.n} of{" "}
                  {item.entry.increment.of} offered
                </span>
                <span className="text-sm">
                  {formatUsdcBaseUnits(item.entry.amountBaseUnits)}
                </span>
              </Card>
            )}
          </li>
        ))}
      </ol>

      {renderPhase(delivery.phase, ownResult)}

      {!terminal && renderDeliveryControls()}

      {!terminal && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!updateText.trim()) return;
            void delivery.sendUpdate(updateText.trim()).then(() => {
              setUpdateText("");
            });
          }}
        >
          <Input
            aria-label="Progress update"
            onChange={(event) => setUpdateText(event.target.value)}
            placeholder="Share free progress narration with the buyer"
            value={updateText}
          />
          <Button
            disabled={delivery.narrating || !updateText.trim()}
            size="sm"
            type="submit"
            variant="outline"
          >
            {delivery.narrating ? "Sending…" : "Send update"}
          </Button>
        </form>
      )}

      {delivery.error ? (
        <p className="text-sm text-destructive">{delivery.error}</p>
      ) : null}
    </div>
  );
}

/**
 * One narration line. A relay-confirmed update and one this session just sent
 * read identically — the provider's own write is the same message either way;
 * only an in-flight or *failed* one is annotated, and a failed one is styled
 * as the retraction it is rather than sitting there looking delivered.
 */
function renderNarration(entry: ProviderNarrationEntry) {
  return (
    <p
      className={cn(
        "rounded-lg px-3 py-2 text-sm",
        entry.delivery === "failed"
          ? "bg-destructive/10 text-destructive"
          : "bg-muted/50 text-muted-foreground",
      )}
    >
      <span>{entry.narration}</span>
      {entry.delivery === "sending" ? (
        <span className="ml-2 text-xs italic">Sending…</span>
      ) : null}
      {entry.delivery === "failed" ? (
        <span className="ml-2 text-xs font-medium">
          Not sent — this update never reached the buyer.
        </span>
      ) : null}
    </p>
  );
}

function renderPhase(
  phase: ProviderDeliveryPhase,
  ownResult: FactoryJobResult | null,
) {
  if (phase.kind === "publishing-result") {
    return (
      <p className="text-sm text-muted-foreground">
        Publishing the job result…
      </p>
    );
  }
  if (phase.kind === "completed" || ownResult?.outcome === "completed") {
    return (
      <Card className="p-3 text-sm font-medium">
        Job completed — every quoted increment was delivered and paid.
      </Card>
    );
  }
  if (phase.kind === "abandoned-buyer") {
    return (
      <Card className="p-3 text-sm font-medium">
        Recorded abandoned-buyer — increment {phase.unpaidIncrement} went
        unpaid, so work stopped at the boundary. Nothing more than one increment
        was ever at risk.
      </Card>
    );
  }
  // The completed case returned above, so a result here is a non-completed one.
  if (ownResult) {
    return (
      <Card className="p-3 text-sm font-medium">
        This job ended as {ownResult.outcome} at increment{" "}
        {ownResult.increment.reached} of {ownResult.increment.of}.
      </Card>
    );
  }
  return null;
}
