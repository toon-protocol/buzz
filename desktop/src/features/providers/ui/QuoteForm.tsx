import * as React from "react";

import type { FactoryJobQuoteIncrementInput } from "@/features/providers/lib/factoryJobQuote";
import { postFactoryJobQuote } from "@/features/providers/lib/postFactoryJobQuote";
import { parseUsdcAmount } from "@/features/payments/lib/paymentsOverview";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/**
 * Quote (buzz#84 "What" §3): an increment schedule and per-increment price
 * against a job's brief. Per decision 7, this is the entire offer — there is
 * no accept step to build a UI for, so the form's only action is "send".
 */

type IncrementRow = { id: number; milestone: string; priceInput: string };

export function QuoteForm({
  canQuote,
  jobId,
  transport,
  onQuoted,
}: {
  /** Whether this agent's connector session is confirmed reachable — see `ProviderJobsPanel`. */
  canQuote: boolean;
  jobId: string;
  transport: ToonEventTransport;
  onQuoted: (event: RelayEvent) => void;
}) {
  // Rows need a stable identity independent of their position — reordering
  // via removal must not make React reconcile the wrong row's input state
  // onto the wrong DOM node.
  const nextRowId = React.useRef(1);
  const newRow = (): IncrementRow => ({
    id: nextRowId.current++,
    milestone: "",
    priceInput: "",
  });

  const [rows, setRows] = React.useState<IncrementRow[]>(() => [newRow()]);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const parsedIncrements: FactoryJobQuoteIncrementInput[] | null = (() => {
    const parsed: FactoryJobQuoteIncrementInput[] = [];
    for (const row of rows) {
      const milestone = row.milestone.trim();
      const priceUsdcBaseUnits = parseUsdcAmount(row.priceInput);
      if (!milestone || priceUsdcBaseUnits === null) return null;
      parsed.push({ milestone, priceUsdcBaseUnits });
    }
    return parsed.length > 0 ? parsed : null;
  })();

  const canSend = parsedIncrements !== null && !sending && canQuote;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!parsedIncrements) return;

    setSending(true);
    setError(null);
    try {
      const posted = await postFactoryJobQuote(
        { rootJobId: jobId, increments: parsedIncrements },
        transport,
      );
      setRows([newRow()]);
      onQuoted(posted);
    } catch (quoteError) {
      setError(
        quoteError instanceof Error
          ? quoteError.message
          : "Failed to send the quote.",
      );
    } finally {
      setSending(false);
    }
  };

  const updateRow = (id: number, patch: Partial<IncrementRow>) => {
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => void handleSubmit(event)}
    >
      {rows.map((row, index) => (
        <div className="flex items-center gap-2" key={row.id}>
          <Input
            aria-label={`Milestone ${index + 1} name`}
            onChange={(event) =>
              updateRow(row.id, { milestone: event.target.value })
            }
            placeholder={`Milestone ${index + 1} (e.g. plan)`}
            value={row.milestone}
          />
          <Input
            aria-label={`Milestone ${index + 1} price in USDC`}
            className="max-w-32"
            inputMode="decimal"
            onChange={(event) =>
              updateRow(row.id, { priceInput: event.target.value })
            }
            placeholder="Price (USDC)"
            value={row.priceInput}
          />
          {rows.length > 1 ? (
            <Button
              onClick={() =>
                setRows((prev) => prev.filter((r) => r.id !== row.id))
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          ) : null}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          onClick={() => setRows((prev) => [...prev, newRow()])}
          size="sm"
          type="button"
          variant="outline"
        >
          Add milestone
        </Button>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      {!canQuote ? (
        <p className="text-xs text-destructive">
          This agent's connector session is not currently reachable — sending a
          quote now would likely be rejected.
        </p>
      ) : null}
      <Button disabled={!canSend} size="sm" type="submit">
        {sending ? "Sending…" : "Send quote"}
      </Button>
    </form>
  );
}
