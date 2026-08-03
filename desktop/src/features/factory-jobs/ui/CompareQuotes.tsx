import type { FactoryJobQuoteComparison } from "@/features/factory-jobs/lib/factoryJobQuoteCompare";
import { gatePassRateLabel } from "@/features/factory-jobs/lib/factoryJobQuoteCompare";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";

/**
 * Compare quotes (buzz#85 "What" §2): schedule and per-increment price next
 * to ambient history and gate-pass rate. Established and cold-start
 * providers render as two distinct groups — never one reputation-sorted
 * list, which would make a new provider invisible (the epic's own
 * cold-start gotcha). There is no "hire" button here: per the protocol,
 * acceptance is paying a provider's increment-1 offer once it arrives
 * (`FactoryJobThread`), not an action on the quote itself.
 */

type QuoteCardProps = {
  row: FactoryJobQuoteComparison["established"][number];
  selected: boolean;
  onSelect: () => void;
};

function QuoteCard({ row, selected, onSelect }: QuoteCardProps) {
  return (
    <Card
      className={`cursor-pointer p-4 transition-colors ${selected ? "border-primary" : ""}`}
      onClick={onSelect}
    >
      <CardHeader className="p-0 pb-2">
        <CardTitle className="text-sm font-medium">
          {truncatePubkey(row.providerPubkey)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-0">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">
            {formatUsdcBaseUnits(row.totalPriceBaseUnits)}
          </span>
          <span className="text-xs text-muted-foreground">
            across {row.incrementCount} increment
            {row.incrementCount === 1 ? "" : "s"}
          </span>
          {row.exceedsBid ? (
            <Badge variant="destructive">above your bid cap</Badge>
          ) : null}
        </div>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {row.increments.map((increment) => (
            <li key={increment.n}>
              {increment.n}/{increment.of} — {increment.milestone} —{" "}
              {formatUsdcBaseUnits(increment.priceUsdcBaseUnits)}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          {row.reputation
            ? `${row.reputation.jobsCompleted} job${row.reputation.jobsCompleted === 1 ? "" : "s"} completed · ${gatePassRateLabel(row.reputation.gatePassRate)}`
            : "New provider — no job history yet"}
        </p>
      </CardContent>
    </Card>
  );
}

export function CompareQuotes({
  comparison,
  selectedProviderPubkey,
  onSelectProvider,
}: {
  comparison: FactoryJobQuoteComparison;
  selectedProviderPubkey: string | null;
  onSelectProvider: (providerPubkey: string) => void;
}) {
  if (
    comparison.established.length === 0 &&
    comparison.coldStart.length === 0
  ) {
    return (
      <p className="text-sm text-muted-foreground">
        No quotes yet — providers reply to the brief when they choose to.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {comparison.established.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">
            Established providers
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {comparison.established.map((row) => (
              <QuoteCard
                key={row.eventId}
                onSelect={() => onSelectProvider(row.providerPubkey)}
                row={row}
                selected={row.providerPubkey === selectedProviderPubkey}
              />
            ))}
          </div>
        </div>
      ) : null}
      {comparison.coldStart.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">
            New providers — no history to show yet, shown deliberately rather
            than sorted to the bottom
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {comparison.coldStart.map((row) => (
              <QuoteCard
                key={row.eventId}
                onSelect={() => onSelectProvider(row.providerPubkey)}
                row={row}
                selected={row.providerPubkey === selectedProviderPubkey}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
