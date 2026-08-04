import {
  buildFactoryJobQuote,
  type FactoryJobQuoteIncrementInput,
} from "@/features/providers/lib/factoryJobQuote";
import { signRelayEvent } from "@/shared/api/tauri";
import type { ToonEventTransport } from "@/shared/api/toonEventTransport";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Publish a quote (buzz#84 "What" §3). Quoting is a paid relay write (the
 * issue's own gotcha — "do not build anything that auto-quotes broadly"), so
 * this is only ever called from a direct user action, never automatically
 * for every matching inbound job.
 *
 * `transport` is the caller's already-resolved TOON transport — same
 * convention as `postFactoryJob.ts`. The caller is also responsible for
 * checking the availability gate (`useFactoryJobAvailability`) before
 * offering the quote action at all; this function does not re-derive it.
 */
export async function postFactoryJobQuote(
  input: {
    rootJobId: string;
    increments: FactoryJobQuoteIncrementInput[];
  },
  transport: ToonEventTransport,
): Promise<RelayEvent> {
  const template = buildFactoryJobQuote(input);
  const event = await signRelayEvent(template);
  return transport.publish(event, {
    timeoutMessage: "Timed out while sending the quote.",
    sendErrorMessage: "Failed to send the quote.",
  });
}
