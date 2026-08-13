import * as React from "react";

import {
  type FactoryJobIncrementOffer,
  type FactoryJobNarration,
  parseFactoryJobFeedback,
} from "@/features/factory-jobs/lib/factoryJobFeedback";
import { parseFactoryJobRequest } from "@/features/factory-jobs/lib/factoryJobRequest";
import {
  type FactoryJobResult,
  isFactoryJobResultMalformed,
  parseFactoryJobResult,
} from "@/features/factory-jobs/lib/factoryJobResult";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import {
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_REQUEST,
  KIND_FACTORY_JOB_RESULT,
} from "@/shared/constants/kinds";

/**
 * Reading side of the buyer surface: fetch-then-follow over the active TOON
 * transport's free reads (`ToonRelayReader`, already the huddle-receive
 * pattern), never `relayClient` — the factory job market lives on the open
 * `g.toon.relay`, not the membership-gated community relay.
 *
 * Only established providers get a reputation entry (buzz#85 gotcha:
 * cold-start providers must stay visible, not silently invisible). Gate-pass
 * rate is left `null` for every provider — `docs/factory-job-protocol.md`
 * §5 does not yet put a gate-pass signal on the kind:6097 wire, so there is
 * nothing honest to compute it from until a later ticket adds one.
 */

function appendByProvider<T>(
  setState: React.Dispatch<React.SetStateAction<Map<string, T[]>>>,
  providerPubkey: string,
  item: T,
) {
  setState((prev) => {
    const next = new Map(prev);
    next.set(providerPubkey, [...(next.get(providerPubkey) ?? []), item]);
    return next;
  });
}

/** All kind:7000 feedback for one job, split by shape, plus per-provider quotes. */
export function useFactoryJobFeedback(
  transport: ToonEventTransport | null,
  jobId: string | null,
) {
  const [quotes, setQuotes] = React.useState<
    Extract<ReturnType<typeof parseFactoryJobFeedback>, { status: "quote" }>[]
  >([]);
  const [offersByProvider, setOffersByProvider] = React.useState<
    Map<string, FactoryJobIncrementOffer[]>
  >(new Map());
  const [narrationByProvider, setNarrationByProvider] = React.useState<
    Map<string, FactoryJobNarration[]>
  >(new Map());
  const seenEventIds = React.useRef(new Set<string>());

  React.useEffect(() => {
    seenEventIds.current = new Set();
    setQuotes([]);
    setOffersByProvider(new Map());
    setNarrationByProvider(new Map());
    if (!transport || !jobId) return;

    const ingest = (raw: {
      id: string;
      pubkey: string;
      created_at: number;
      kind: number;
      content: string;
      tags: string[][];
    }) => {
      if (seenEventIds.current.has(raw.id)) return;
      seenEventIds.current.add(raw.id);

      const parsed = parseFactoryJobFeedback(raw);
      if (!parsed || parsed.status === "malformed") return;

      if (parsed.status === "quote") {
        setQuotes((prev) => [...prev, parsed]);
        return;
      }
      if (parsed.status === "partial") {
        appendByProvider(setOffersByProvider, parsed.providerPubkey, parsed);
        return;
      }
      appendByProvider(setNarrationByProvider, parsed.providerPubkey, parsed);
    };

    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;

    const filter = {
      kinds: [KIND_FACTORY_JOB_FEEDBACK],
      "#e": [jobId],
      limit: 500,
    };

    void transport.fetchEvents(filter).then((events) => {
      if (disposed) return;
      for (const event of events) ingest(event);
    });
    void transport.subscribeLive(filter, ingest).then((result) => {
      if (disposed) {
        void result();
        return;
      }
      dispose = result;
    });

    return () => {
      disposed = true;
      void dispose?.();
    };
  }, [transport, jobId]);

  return { quotes, offersByProvider, narrationByProvider };
}

/** The buyer's own posted jobs. */
export function useOwnFactoryJobs(
  transport: ToonEventTransport | null,
  buyerPubkey: string | null,
) {
  const [requests, setRequests] = React.useState<
    NonNullable<ReturnType<typeof parseFactoryJobRequest>>[]
  >([]);

  React.useEffect(() => {
    setRequests([]);
    if (!transport || !buyerPubkey) return;
    let cancelled = false;

    void transport
      .fetchEvents({
        kinds: [KIND_FACTORY_JOB_REQUEST],
        authors: [buyerPubkey],
        limit: 100,
      })
      .then((events) => {
        if (cancelled) return;
        const parsed = events
          .map(parseFactoryJobRequest)
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => b.createdAt - a.createdAt);
        setRequests(parsed);
      });

    return () => {
      cancelled = true;
    };
  }, [transport, buyerPubkey]);

  return requests;
}

/**
 * The terminal kind:6097 results for one job (buzz#135), fetch-then-follow
 * over the same free read path as the feedback thread — parsed by the
 * existing `parseFactoryJobResult`, which is exactly the compatibility bar
 * the provider's published results must clear.
 */
export function useFactoryJobResults(
  transport: ToonEventTransport | null,
  jobId: string | null,
) {
  const [results, setResults] = React.useState<FactoryJobResult[]>([]);
  const seenEventIds = React.useRef(new Set<string>());

  React.useEffect(() => {
    seenEventIds.current = new Set();
    setResults([]);
    if (!transport || !jobId) return;

    const ingest = (raw: {
      id: string;
      pubkey: string;
      created_at: number;
      kind: number;
      tags: string[][];
    }) => {
      if (seenEventIds.current.has(raw.id)) return;
      seenEventIds.current.add(raw.id);
      const parsed = parseFactoryJobResult(raw);
      if (parsed && !isFactoryJobResultMalformed(parsed)) {
        setResults((prev) => [...prev, parsed]);
      }
    };

    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;
    const filter = {
      kinds: [KIND_FACTORY_JOB_RESULT],
      "#e": [jobId],
      limit: 50,
    };

    void transport.fetchEvents(filter).then((events) => {
      if (disposed) return;
      for (const event of events) ingest(event);
    });
    void transport.subscribeLive(filter, ingest).then((result) => {
      if (disposed) {
        void result();
        return;
      }
      dispose = result;
    });

    return () => {
      disposed = true;
      void dispose?.();
    };
  }, [transport, jobId]);

  return results;
}

/**
 * Ambient job history per candidate provider — decision 8's first reputation
 * signal. Counts completed kind:6097 results authored by that pubkey,
 * across any job, over the same free read path.
 */
export function useProviderJobHistory(
  transport: ToonEventTransport | null,
  providerPubkeys: readonly string[],
) {
  const [completedByProvider, setCompletedByProvider] = React.useState<
    Map<string, number>
  >(new Map());

  React.useEffect(() => {
    setCompletedByProvider(new Map());
    if (!transport || providerPubkeys.length === 0) return;
    let cancelled = false;

    void transport
      .fetchEvents({
        kinds: [KIND_FACTORY_JOB_RESULT],
        authors: [...providerPubkeys],
        limit: 500,
      })
      .then((events) => {
        if (cancelled) return;
        const counts = new Map<string, number>();
        for (const event of events) {
          const result = parseFactoryJobResult(event);
          if (
            result &&
            !isFactoryJobResultMalformed(result) &&
            result.outcome === "completed"
          ) {
            counts.set(
              result.providerPubkey,
              (counts.get(result.providerPubkey) ?? 0) + 1,
            );
          }
        }
        setCompletedByProvider(counts);
      });

    return () => {
      cancelled = true;
    };
    // Caller must memoize `providerPubkeys` (a stable array reference) — see
    // `FactoryJobsScreen`'s `React.useMemo` over the comparison rows.
  }, [transport, providerPubkeys]);

  return completedByProvider;
}
