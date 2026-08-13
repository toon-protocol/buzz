import * as React from "react";

import type { PaidArtifactState } from "@/features/factory-jobs/lib/factoryJobArtifact";
import {
  checkOfferPayable,
  deriveFactoryJobExposure,
  factoryJobExposureCaption,
} from "@/features/factory-jobs/lib/factoryJobExposure";
import type {
  FactoryJobIncrementOffer,
  FactoryJobNarration,
  FactoryJobQuoteIncrement,
} from "@/features/factory-jobs/lib/factoryJobFeedback";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

/**
 * Follow the job (buzz#85 "What" §4/§5): free narration as it arrives, then
 * each increment offer with its price, paid one at a time. The exposure
 * banner is the property the whole surface exists to make visible — "you can
 * stop at any increment, having risked at most one" — never a generic
 * progress bar (the issue's own gotcha).
 */

type FeedItem =
  | ({ feedKind: "narration" } & FactoryJobNarration)
  | ({ feedKind: "offer" } & FactoryJobIncrementOffer);

type FactoryJobThreadProps = {
  schedule: FactoryJobQuoteIncrement[];
  offers: FactoryJobIncrementOffer[];
  narration: FactoryJobNarration[];
  /** Increment numbers already paid — see `JobDetail` in `FactoryJobsScreen`. */
  paidIncrementNumbers: ReadonlySet<number>;
  payingIncrementNumber: number | null;
  payError: string | null;
  fulfillmentByIncrement: ReadonlyMap<number, string>;
  /** The decrypt tail per paid increment (buzz#135) — see `FactoryJobsScreen`. */
  artifactByIncrement: ReadonlyMap<number, PaidArtifactState>;
  onPayIncrement: (offer: FactoryJobIncrementOffer) => void;
};

export function FactoryJobThread({
  schedule,
  offers,
  narration,
  paidIncrementNumbers,
  payingIncrementNumber,
  payError,
  fulfillmentByIncrement,
  artifactByIncrement,
  onPayIncrement,
}: FactoryJobThreadProps) {
  const exposure = React.useMemo(
    () =>
      deriveFactoryJobExposure(
        schedule.map((entry) => ({
          n: entry.n,
          priceUsdcBaseUnits: entry.priceUsdcBaseUnits,
        })),
        paidIncrementNumbers,
      ),
    [schedule, paidIncrementNumbers],
  );

  const feed: FeedItem[] = React.useMemo(
    () =>
      [
        ...narration.map((entry) => ({
          feedKind: "narration" as const,
          ...entry,
        })),
        ...offers.map((entry) => ({ feedKind: "offer" as const, ...entry })),
      ].sort((a, b) => a.createdAt - b.createdAt),
    [narration, offers],
  );

  const nextPayableIncrement = exposure.paidCount + 1;

  function renderOfferAction(item: FactoryJobIncrementOffer) {
    if (paidIncrementNumbers.has(item.increment.n)) {
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Badge variant="success">Paid</Badge>
            <span className="font-mono text-xs text-muted-foreground">
              key {fulfillmentByIncrement.get(item.increment.n)?.slice(0, 16)}…
            </span>
            <a
              className="text-xs text-primary underline"
              href={item.artifactUrl}
              rel="noreferrer"
              target="_blank"
            >
              artifact
            </a>
          </div>
          {renderPaidArtifact(artifactByIncrement.get(item.increment.n))}
        </div>
      );
    }

    if (item.increment.n !== nextPayableIncrement) {
      return (
        <span className="text-xs text-muted-foreground">
          Waiting on increment {nextPayableIncrement} first — the key that pays
          this one arrives at delivery, never before.
        </span>
      );
    }

    const payability = checkOfferPayable(item, schedule);
    if (!payability.payable) {
      return (
        <p className="text-xs text-destructive">
          Not payable — {payability.reason}
        </p>
      );
    }

    return (
      <Button
        disabled={payingIncrementNumber === item.increment.n}
        onClick={() => onPayIncrement(item)}
        size="sm"
      >
        {payingIncrementNumber === item.increment.n
          ? "Paying…"
          : item.increment.n === 1
            ? "Pay & hire"
            : "Pay this increment"}
      </Button>
    );
  }

  function renderPaidArtifact(state: PaidArtifactState | undefined) {
    if (!state) return null;
    if (state.kind === "loading") {
      return (
        <p className="text-xs text-muted-foreground">
          Fetching and decrypting the paid artifact…
        </p>
      );
    }
    if (state.kind === "error") {
      return <p className="text-xs text-destructive">{state.message}</p>;
    }
    return state.content.kind === "text" ? (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2 text-xs">
        {state.content.text}
      </pre>
    ) : (
      <p className="text-xs text-muted-foreground">
        Decrypted a {state.content.byteLength}-byte binary artifact.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="border-primary/30 bg-primary/5 p-3 text-sm font-medium">
        {factoryJobExposureCaption(exposure)}
      </Card>
      <ol className="flex flex-col gap-2">
        {feed.map((item) => (
          <li key={item.eventId}>
            {item.feedKind === "narration" ? (
              <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                {item.narration}
              </p>
            ) : (
              <Card className="flex flex-col gap-2 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Increment {item.increment.n} of {item.increment.of}
                  </span>
                  <span className="text-sm">
                    {formatUsdcBaseUnits(item.amountBaseUnits)}
                  </span>
                </div>
                {renderOfferAction(item)}
              </Card>
            )}
          </li>
        ))}
      </ol>
      {payError ? <p className="text-sm text-destructive">{payError}</p> : null}
    </div>
  );
}
