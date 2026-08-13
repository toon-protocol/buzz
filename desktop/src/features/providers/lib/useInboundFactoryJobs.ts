import * as React from "react";

import { parseFactoryJobFeedback } from "@/features/factory-jobs/lib/factoryJobFeedback";
import {
  type FactoryJobRequest,
  parseFactoryJobRequest,
} from "@/features/factory-jobs/lib/factoryJobRequest";
import type { ProviderCapabilitySettings } from "@/features/providers/lib/providerCapabilitySettings";
import {
  isOwnFactoryJob,
  matchesProviderCapability,
} from "@/features/providers/lib/providerJobMatch";
import { unwrapFactoryJobRequestGift } from "@/features/providers/lib/unwrapFactoryJobRequest";
import { getIdentitySecretKey } from "@/shared/api/identitySecretKey";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_FACTORY_JOB_FEEDBACK,
  KIND_FACTORY_JOB_REQUEST,
  KIND_GIFT_WRAP,
} from "@/shared/constants/kinds";

/**
 * Inbound job feed (buzz#84 "What" §2): every open `kind:5097` request on
 * `g.toon.relay` this agent is willing to serve, plain or gift-wrapped to
 * it, merged with whether this agent has already quoted it.
 *
 * Reuses the exact free-read path buzz#85's buyer surface already
 * established (`transport.fetchEvents`/`subscribeLive`, never `relayClient`
 * — the factory job market lives on the open relay, not the membership-
 * gated one). No filter is applied at the relay for job type or repo: there
 * is only one job kind today (decision 4 of toon-meta#262), so the query is
 * unscoped by author, and two client-side filters narrow it: `isOwnFactoryJob`
 * drops a brief this agent posted itself as a buyer — it can never quote its
 * own job — and `matchesProviderCapability` narrows to what the owner has
 * opted into (advertising off hides everything, since quoting costs money
 * and nothing should look quotable until the owner opts in).
 */

export type InboundFactoryJob = FactoryJobRequest & {
  /** Whether this agent has already sent a kind:7000 quote for this job. */
  alreadyQuoted: boolean;
  /** Whether this brief arrived NIP-59 gift-wrapped rather than in the open. */
  giftWrapped: boolean;
  /**
   * The kind:5097 request event verbatim (buzz#135) — what a delivery's
   * terminal kind:6097 result carries in its `request` tag (§5.1). For a
   * gift-wrapped brief this is the reconstituted rumor (unsigned by NIP-59
   * design — see `unwrapFactoryJobRequest.ts`), not a public relay event.
   */
  requestEvent: RelayEvent;
};

type Entry = {
  request: FactoryJobRequest;
  giftWrapped: boolean;
  requestEvent: RelayEvent;
};

export function useInboundFactoryJobs(
  transport: ToonEventTransport | null,
  myPubkey: string | null,
  settings: ProviderCapabilitySettings,
): InboundFactoryJob[] {
  const [entriesById, setEntriesById] = React.useState<Map<string, Entry>>(
    new Map(),
  );
  const [quotedRootIds, setQuotedRootIds] = React.useState<Set<string>>(
    new Set(),
  );

  React.useEffect(() => {
    setEntriesById(new Map());
    if (!transport) return;

    const addEntry = (entry: Entry) => {
      setEntriesById((prev) => {
        if (prev.has(entry.request.eventId)) return prev;
        const next = new Map(prev);
        next.set(entry.request.eventId, entry);
        return next;
      });
    };

    const ingestPlain = (raw: RelayEvent) => {
      const parsed = parseFactoryJobRequest(raw);
      if (parsed) {
        addEntry({ request: parsed, giftWrapped: false, requestEvent: raw });
      }
    };

    // A raw private key round-trips over Tauri IPC once per wrap rather than
    // being held anywhere in this hook — see `identitySecretKey.ts`'s own
    // doc on why it is deliberately not cached.
    const ingestWrap = (raw: RelayEvent) => {
      void getIdentitySecretKey().then((secretKey) => {
        const grant = unwrapFactoryJobRequestGift(raw, secretKey);
        if (grant) {
          addEntry({
            request: grant.request,
            giftWrapped: true,
            requestEvent: grant.requestEvent,
          });
        }
      });
    };

    let disposed = false;
    const disposers: Array<() => Promise<void>> = [];

    const requestFilter = { kinds: [KIND_FACTORY_JOB_REQUEST], limit: 500 };
    void transport.fetchEvents(requestFilter).then((events) => {
      if (disposed) return;
      for (const event of events) ingestPlain(event);
    });
    void transport.subscribeLive(requestFilter, ingestPlain).then((dispose) => {
      if (disposed) {
        void dispose();
        return;
      }
      disposers.push(dispose);
    });

    if (myPubkey) {
      const wrapFilter = {
        kinds: [KIND_GIFT_WRAP],
        "#p": [myPubkey],
        limit: 200,
      };
      void transport.fetchEvents(wrapFilter).then((events) => {
        if (disposed) return;
        for (const event of events) ingestWrap(event);
      });
      void transport.subscribeLive(wrapFilter, ingestWrap).then((dispose) => {
        if (disposed) {
          void dispose();
          return;
        }
        disposers.push(dispose);
      });
    }

    return () => {
      disposed = true;
      for (const dispose of disposers) void dispose();
    };
  }, [transport, myPubkey]);

  React.useEffect(() => {
    setQuotedRootIds(new Set());
    if (!transport || !myPubkey) return;
    let cancelled = false;

    void transport
      .fetchEvents({
        kinds: [KIND_FACTORY_JOB_FEEDBACK],
        authors: [myPubkey],
        limit: 500,
      })
      .then((events) => {
        if (cancelled) return;
        const ids = new Set<string>();
        for (const event of events) {
          const parsed = parseFactoryJobFeedback(event);
          if (parsed && parsed.status !== "malformed") {
            ids.add(parsed.rootJobId);
          }
        }
        setQuotedRootIds(ids);
      });

    return () => {
      cancelled = true;
    };
  }, [transport, myPubkey]);

  return React.useMemo(
    () =>
      [...entriesById.values()]
        .filter((entry) => !isOwnFactoryJob(entry.request, myPubkey))
        .filter((entry) => matchesProviderCapability(entry.request, settings))
        .map((entry) => ({
          ...entry.request,
          giftWrapped: entry.giftWrapped,
          requestEvent: entry.requestEvent,
          alreadyQuoted: quotedRootIds.has(entry.request.eventId),
        }))
        .sort((a, b) => b.createdAt - a.createdAt),
    [entriesById, quotedRootIds, settings, myPubkey],
  );
}
