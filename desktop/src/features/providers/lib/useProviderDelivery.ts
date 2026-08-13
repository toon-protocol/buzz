import * as React from "react";

import type {
  FactoryJobIncrementOffer,
  FactoryJobQuote,
} from "@/features/factory-jobs/lib/factoryJobFeedback";
import {
  deliverFactoryJobIncrement,
  publishFactoryJobNarration,
  publishFactoryJobResult,
} from "@/features/providers/lib/deliverFactoryJobIncrement";
import type { LocalNarration } from "@/features/providers/lib/providerNarrationFeed";
import type { InboundFactoryJob } from "@/features/providers/lib/useInboundFactoryJobs";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";

/**
 * The provider's per-job delivery state machine (buzz#135). One increment in
 * flight at a time — the delivery port's own sequential contract — enforced
 * here by refusing to start a delivery unless the machine is at rest.
 *
 * Which increment is next is derived from the offers already visible (this
 * session's plus any of this provider's own offers read back off the relay),
 * so a remounted panel continues the schedule instead of re-offering
 * increment 1. Payment state, by contrast, is session-local by nature: a
 * FULFILL is a private packet, not a relay event, so an offer from an
 * earlier session reads as "offered" but can never read as "paid" here.
 *
 * Terminal transitions publish the kind:6097 result themselves: `completed`
 * the moment the final quoted increment is paid, `abandoned-buyer` the
 * moment an offered increment's payment window elapses unpaid (§5.2) — the
 * two outcomes an interactive delivery surface can honestly reach.
 *
 * Narration is the one thing this hook renders optimistically: `sendUpdate`
 * records the entry in `localNarration` before the write starts, marks it
 * `sent`/`failed` when the publish settles, and stamps the signed event id on
 * it so `mergeOwnNarration` can drop it once the relay echo arrives. See
 * `providerNarrationFeed.ts` for why narration and nothing else.
 */

export type ProviderDeliveryPhase =
  | { kind: "idle" }
  | { kind: "delivering"; n: number }
  | { kind: "awaiting-payment"; n: number }
  | { kind: "publishing-result"; outcome: "completed" | "abandoned-buyer" }
  | { kind: "completed" }
  | { kind: "abandoned-buyer"; unpaidIncrement: number };

/** An offer published THIS session — the relay read-back can lag it (see above). */
type SessionOffer = {
  n: number;
  eventId: string;
};

export function useProviderDelivery({
  transport,
  job,
  quote,
  wireOffers,
}: {
  transport: ToonEventTransport;
  job: InboundFactoryJob;
  /** This provider's own quote for the job, or null before one exists. */
  quote: FactoryJobQuote | null;
  /** This provider's own offers as read back off the relay. */
  wireOffers: FactoryJobIncrementOffer[];
}) {
  const [phase, setPhase] = React.useState<ProviderDeliveryPhase>({
    kind: "idle",
  });
  const [sessionOffers, setSessionOffers] = React.useState<SessionOffer[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [narrating, setNarrating] = React.useState(false);
  const [localNarration, setLocalNarration] = React.useState<LocalNarration[]>(
    [],
  );

  const patchLocalNarration = (
    localKey: string,
    patch: Partial<LocalNarration>,
  ) => {
    setLocalNarration((prev) =>
      prev.map((entry) =>
        entry.localKey === localKey ? { ...entry, ...patch } : entry,
      ),
    );
  };

  const totalIncrements = quote?.increments.length ?? 0;

  const highestOffered = Math.max(
    0,
    ...wireOffers.map((offer) => offer.increment.n),
    ...sessionOffers.map((offer) => offer.n),
  );
  const nextIncrementN = highestOffered + 1;

  /** The thread event a fresh offer/narration replies to (§4.1's `reply` tag). */
  const parentEventId =
    sessionOffers.at(-1)?.eventId ??
    wireOffers.at(-1)?.eventId ??
    quote?.eventId ??
    null;

  const nextIncrement =
    quote?.increments.find((entry) => entry.n === nextIncrementN) ?? null;

  const deliverNext = async (artifactText: string) => {
    if (!quote || !nextIncrement || parentEventId === null) return;
    if (phase.kind !== "idle") return;

    const n = nextIncrement.n;
    setError(null);
    setPhase({ kind: "delivering", n });
    try {
      const delivered = await deliverFactoryJobIncrement(
        {
          job,
          parentEventId,
          increment: {
            n,
            of: totalIncrements,
            milestone: nextIncrement.milestone,
            priceUsdcBaseUnits: nextIncrement.priceUsdcBaseUnits,
          },
          artifactBytes: new TextEncoder().encode(artifactText),
        },
        transport,
        () => setPhase({ kind: "awaiting-payment", n }),
      );

      setSessionOffers((prev) => [
        ...prev,
        { n, eventId: delivered.offerEvent.id },
      ]);

      if (!delivered.paid) {
        // §5.2: the buyer stopped paying an increment the provider offered.
        setPhase({ kind: "publishing-result", outcome: "abandoned-buyer" });
        await publishFactoryJobResult(
          {
            job,
            requestEvent: job.requestEvent,
            giftWrapped: job.giftWrapped,
            lastEventId: delivered.offerEvent.id,
            outcome: "abandoned-buyer",
            reachedIncrement: n - 1,
            totalIncrements,
          },
          transport,
        );
        setPhase({ kind: "abandoned-buyer", unpaidIncrement: n });
        return;
      }

      if (n === totalIncrements) {
        setPhase({ kind: "publishing-result", outcome: "completed" });
        await publishFactoryJobResult(
          {
            job,
            requestEvent: job.requestEvent,
            giftWrapped: job.giftWrapped,
            lastEventId: delivered.offerEvent.id,
            outcome: "completed",
            reachedIncrement: n,
            totalIncrements,
            finalArtifactTxId: delivered.artifactTxId,
          },
          transport,
        );
        setPhase({ kind: "completed" });
        return;
      }

      setPhase({ kind: "idle" });
    } catch (deliveryError) {
      setError(
        deliveryError instanceof Error
          ? deliveryError.message
          : "Failed to deliver this increment.",
      );
      setPhase({ kind: "idle" });
    }
  };

  const sendUpdate = async (message: string) => {
    if (parentEventId === null || narrating) return;

    // Render it in the provider's own thread NOW — before signing, before the
    // paid write, and long before the relay echoes it back.
    const localKey = `local-narration-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    setLocalNarration((prev) => [
      ...prev,
      {
        localKey,
        eventId: null,
        message,
        createdAt: Math.floor(Date.now() / 1000),
        delivery: "sending",
      },
    ]);
    setNarrating(true);
    setError(null);
    try {
      const published = await publishFactoryJobNarration(
        { job, parentEventId, message },
        transport,
        // Stamp the id at SIGNING time, not on publish success: a write that
        // fails after the relay stored the event must still dedupe against
        // the echo instead of rendering the message twice.
        (signed) => patchLocalNarration(localKey, { eventId: signed.id }),
      );
      patchLocalNarration(localKey, {
        eventId: published.id,
        delivery: "sent",
      });
    } catch (narrationError) {
      // Never leave an undelivered update looking delivered (§6 is the
      // buyer's only progress signal — a phantom one is worse than none).
      patchLocalNarration(localKey, { delivery: "failed" });
      setError(
        narrationError instanceof Error
          ? narrationError.message
          : "Failed to send the update.",
      );
    } finally {
      setNarrating(false);
    }
  };

  return {
    phase,
    error,
    narrating,
    /** This session's own narration, for optimistic render + reconciliation. */
    localNarration,
    /** The next increment to deliver, or null when the schedule is exhausted (or unquoted). */
    nextIncrement,
    deliverNext,
    sendUpdate,
  };
}
