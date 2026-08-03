import * as React from "react";

import { postFactoryJob } from "@/features/factory-jobs/lib/postFactoryJob";
import { parseUsdcAmount } from "@/features/payments/lib/paymentsOverview";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

/**
 * Post a job (buzz#85 "What" §1): brief, bid cap, and whether to gift-wrap it
 * (decision 1). A gift wrap only makes sense once a specific provider is
 * targeted — broadcasting to an unknown set of candidate providers needs
 * every one of them to be able to read the brief, which encrypting to a
 * single recipient defeats.
 */

type PostJobFormProps = {
  transport: ToonEventTransport;
  onPosted: (event: RelayEvent) => void;
};

export function PostJobForm({ transport, onPosted }: PostJobFormProps) {
  const [brief, setBrief] = React.useState("");
  const [bidInput, setBidInput] = React.useState("");
  const [targetProviderPubkey, setTargetProviderPubkey] = React.useState("");
  const [giftWrap, setGiftWrap] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const bidBaseUnits = parseUsdcAmount(bidInput);
  const canPost =
    brief.trim().length > 0 &&
    bidBaseUnits !== null &&
    !posting &&
    (!giftWrap || targetProviderPubkey.trim().length > 0);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canPost || bidBaseUnits === null) return;

    setPosting(true);
    setError(null);
    try {
      const posted = await postFactoryJob(
        {
          brief: brief.trim(),
          bidBaseUnits,
          targetProviderPubkey: targetProviderPubkey.trim() || undefined,
        },
        transport,
        { giftWrap },
      );
      setBrief("");
      setBidInput("");
      setTargetProviderPubkey("");
      setGiftWrap(false);
      onPosted(posted);
    } catch (postError) {
      setError(
        postError instanceof Error
          ? postError.message
          : "Failed to post the job.",
      );
    } finally {
      setPosting(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <Textarea
        aria-label="Job brief"
        onChange={(event) => setBrief(event.target.value)}
        placeholder="Describe the job — what needs doing, and any constraints a provider needs to quote accurately."
        value={brief}
      />
      <div className="flex items-center gap-2">
        <Input
          aria-label="Bid cap in USDC"
          className="max-w-40"
          inputMode="decimal"
          onChange={(event) => setBidInput(event.target.value)}
          placeholder="Bid cap (USDC)"
          value={bidInput}
        />
        <span className="text-xs text-muted-foreground">
          The most you will pay across the whole job — not per increment.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Target a specific provider (optional)"
          onChange={(event) => setTargetProviderPubkey(event.target.value)}
          placeholder="Target a specific provider by pubkey (optional)"
          value={targetProviderPubkey}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          checked={giftWrap}
          disabled={targetProviderPubkey.trim().length === 0}
          onChange={(event) => setGiftWrap(event.target.checked)}
          type="checkbox"
        />
        Gift-wrap this brief so the relay sees neither its content nor who sent
        it (only the targeted provider can read it)
      </label>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button disabled={!canPost} type="submit">
        {posting ? "Posting…" : "Post job"}
      </Button>
    </form>
  );
}
