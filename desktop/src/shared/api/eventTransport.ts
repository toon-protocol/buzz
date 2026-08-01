import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { relayEventTransport } from "@/shared/api/relayEventTransport";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The transport seam: the one place the desktop app hands a signed event to
 * whatever carries it to the network.
 *
 * Everything upstream of the seam — building tags, encrypting content, signing
 * through Tauri — stays transport-agnostic and therefore cherry-pickable from
 * `block/buzz` (ADR 0001). Everything downstream is transport-specific:
 * connection lifecycle, authentication, acknowledgement, and (for a future
 * paid transport) payment.
 *
 * Call sites never import a relay client to write. They import the free
 * functions below; the active `EventTransport` decides where the event goes.
 * Adding a second transport is `setEventTransport(...)` plus one new
 * implementation of this interface — no call site changes.
 *
 * The seam carries the app's LIVE READS too ({@link EventTransport.subscribeLive}).
 * A transport that writes somewhere the app cannot read from is not a
 * transport, it is a dead letter box: on TOON the paid write lands on a
 * different relay than `relayClient` is attached to, so a message the user
 * just sent would never come back. Live subscriptions therefore move with the
 * write. History paging does NOT yet — `channelWindow.ts` still asks
 * buzz-relay's REST window, which server-assembles thread summaries and aux
 * overlays that a plain NIP-01 REQ cannot reproduce.
 *
 * Writes that are deliberately NOT on this seam:
 * - `ReadOnlyRelayClient` (`readOnlyRelayClient.ts`) publishes read-state to an
 *   explicitly passed relay URL for *inactive* communities. It is scoped to a
 *   caller-supplied URL rather than the active community, so it has its own
 *   session; a second transport has to grow a per-URL form before it can
 *   absorb this path.
 * - The Rust side. Tauri commands such as `send_channel_message`, `add_reaction`
 *   and `create_channel` build, sign, and POST their events from
 *   `src-tauri/src`. As of buzz#27 they all funnel through
 *   `event_transport::dispatch` — a seam of its own, mirroring this one — so
 *   the same `BUZZ_TRANSPORT` switch this file reads also governs the Rust
 *   side; on `toon` it bridges to whichever `EventTransport` is active here
 *   (see `rustWriteBridge.ts`) rather than POSTing directly.
 */
export interface EventTransport {
  /**
   * Bring the transport up so a publish that follows does not pay a
   * connect/handshake round-trip inside its own timeout budget. Callers that
   * sign before publishing use this to keep signing off the critical path.
   */
  ready(): Promise<void>;

  /**
   * Whether a write can go out right now with no connect first. Callers use
   * this to skip building and signing an event they would only drop — see
   * `sendTypingIndicator`.
   */
  isWritable(): boolean;

  /**
   * Publish a signed event and resolve once the transport confirms the write
   * was accepted. Rejects with `messages.timeoutMessage` when confirmation
   * never arrives and `messages.sendErrorMessage` when the send itself fails.
   */
  publish(
    event: RelayEvent,
    messages: PublishFailureMessages,
  ): Promise<RelayEvent>;

  /**
   * Publish without waiting for confirmation, dropping the event when the
   * transport is not writable. Only for events whose loss is acceptable
   * (typing indicators and friends).
   */
  publishEphemeral(event: RelayEvent): Promise<void>;

  /**
   * Attach a live subscription for `filter`, resolving with a dispose once the
   * transport has caught the caller up. The tail of a channel arrives through
   * here, so it must be served by the same network the writes go to.
   */
  subscribeLive(
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
  ): Promise<() => Promise<void>>;
}

/**
 * User-facing failure copy for a publish. Each call site owns the wording for
 * its own operation, so the seam carries it rather than inventing generic text.
 */
export type PublishFailureMessages = {
  timeoutMessage: string;
  sendErrorMessage: string;
};

let activeTransport: EventTransport = relayEventTransport;

/** The transport every write currently goes through. */
export function getEventTransport(): EventTransport {
  return activeTransport;
}

/**
 * Swap the active transport. The relay transport is the only implementation
 * today; this is the hook a second one is installed through.
 */
export function setEventTransport(transport: EventTransport): void {
  activeTransport = transport;
}

/** Restore the default relay transport. */
export function resetEventTransport(): void {
  activeTransport = relayEventTransport;
}

/** See {@link EventTransport.ready}. */
export function ensureTransportReady(): Promise<void> {
  return activeTransport.ready();
}

/** See {@link EventTransport.isWritable}. */
export function isTransportWritable(): boolean {
  return activeTransport.isWritable();
}

/** See {@link EventTransport.publish}. */
export function publishEvent(
  event: RelayEvent,
  timeoutMessage: string,
  sendErrorMessage: string,
): Promise<RelayEvent> {
  return activeTransport.publish(event, { timeoutMessage, sendErrorMessage });
}

/** See {@link EventTransport.publishEphemeral}. */
export function publishEphemeralEvent(event: RelayEvent): Promise<void> {
  return activeTransport.publishEphemeral(event);
}

/** See {@link EventTransport.subscribeLive}. */
export function subscribeLiveEvents(
  filter: RelaySubscriptionFilter,
  onEvent: (event: RelayEvent) => void,
): Promise<() => Promise<void>> {
  return activeTransport.subscribeLive(filter, onEvent);
}
