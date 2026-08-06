import * as React from "react";

import type {
  FactoryJobIncrementOffer,
  FactoryJobNarration,
} from "@/features/factory-jobs/lib/factoryJobFeedback";
import {
  useFactoryJobFeedback,
  useFactoryJobResults,
} from "@/features/factory-jobs/lib/useFactoryJobBuyer";
import type { InboundFactoryJob } from "@/features/providers/lib/useInboundFactoryJobs";
import { useProviderDelivery } from "@/features/providers/lib/useProviderDelivery";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";

/**
 * The provider's side of a hired job's thread (buzz#135) — the counterpart
 * of the buyer's `FactoryJobThread`. Reads the SAME wire through the SAME
 * parsers (`useFactoryJobFeedback` / `useFactoryJobResults`): what renders
 * here is what the provider actually published, not a local echo — so a
 * delivery that would not render for the buyer does not render here either.
 *
 * Delivery controls are gated on the transport's BTP session
 * (`ToonPaidWriter.supportsJobDelivery`): key release rides the provider's
 * own session, so an HTTP-only transport shows the reason instead of a
 * Deliver button that could only ever strand an offer unreleasable.
 */

type ThreadItem =
  | ({ feedKind: "narration" } & FactoryJobNarration)
  | ({ feedKind: "offer" } & FactoryJobIncrementOffer);

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

  const ownQuote = React.useMemo(() => {
    const own = quotes.filter((quote) => quote.providerPubkey === myPubkey);
    return own.length > 0 ? own[own.length - 1] : null;
  }, [quotes, myPubkey]);
  const ownOffers = React.useMemo(
    () => offersByProvider.get(myPubkey) ?? [],
    [offersByProvider, myPubkey],
  );
  const ownNarration = narrationByProvider.get(myPubkey) ?? [];
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

  const feed: ThreadItem[] = React.useMemo(
    () =>
      [
        ...ownNarration.map((entry) => ({
          feedKind: "narration" as const,
          ...entry,
        })),
        ...ownOffers.map((entry) => ({ feedKind: "offer" as const, ...entry })),
      ].sort((a, b) => a.createdAt - b.createdAt),
    [ownNarration, ownOffers],
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

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {feed.map((item) => (
          <li key={item.eventId}>
            {item.feedKind === "narration" ? (
              <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                {item.narration}
              </p>
            ) : (
              <Card className="flex items-center justify-between p-3">
                <span className="text-sm font-medium">
                  Increment {item.increment.n} of {item.increment.of} offered
                </span>
                <span className="text-sm">
                  {formatUsdcBaseUnits(item.amountBaseUnits)}
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
}

function renderPhase(
  phase: ReturnType<typeof useProviderDelivery>["phase"],
  ownResult: ReturnType<typeof useFactoryJobResults>[number] | null,
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
