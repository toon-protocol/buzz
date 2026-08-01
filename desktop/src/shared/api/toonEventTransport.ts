import type {
  EventTransport,
  PublishFailureMessages,
} from "@/shared/api/eventTransport";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import {
  formatFee,
  type PaidWriteListener,
  ToonPaidWriter,
} from "@/shared/api/toonPaidWriter";
import {
  ToonRelayReader,
  type ToonSubscriptionDispose,
} from "@/shared/api/toonRelayReader";
import type { ToonTransportConfig } from "@/shared/api/toonTransportConfig";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The transport seam's TOON implementation: paid writes out through a
 * connector edge, free reads back from the relay behind it.
 *
 * The asymmetry is the whole point of the network and shows up directly in
 * this class. Writing costs a payment-channel claim and goes over ILP-over-
 * HTTP to `ToonPaidWriter`; reading costs nothing and goes over a plain
 * WebSocket subscription in `ToonRelayReader`. Nothing above the seam knows
 * either of those things — `sendStreamMessage` calls `publishEvent` exactly as
 * it does on the relay transport.
 *
 * What this transport deliberately does NOT do:
 * - **Ephemeral writes are dropped.** `publishEphemeral` carries typing
 *   indicators. Paying a per-packet fee for a keystroke is not a tradeoff
 *   worth making silently, and the seam already defines these events as
 *   loss-tolerant.
 * - **It does not cover the Rust write path.** Threaded replies, media, and
 *   custom-emoji messages are built and POSTed from `src-tauri` and never
 *   reach this seam (see `eventTransport.ts`). On TOON those writes go
 *   nowhere; a plaintext top-level message is what round-trips today.
 */
export class ToonEventTransport implements EventTransport {
  private readonly writer: ToonPaidWriter;
  private readonly reader: ToonRelayReader;

  constructor(
    config: ToonTransportConfig,
    parts?: { writer?: ToonPaidWriter; reader?: ToonRelayReader },
  ) {
    this.writer = parts?.writer ?? new ToonPaidWriter(config);
    this.reader = parts?.reader ?? new ToonRelayReader(config.relayUrl);
  }

  /**
   * Bring both halves up. Reads and writes are independent networks, so a
   * failure to open the payment channel must not cost the caller its
   * subscription — an unfunded client can still read the channel it cannot
   * write to.
   */
  async ready(): Promise<void> {
    const [, write] = await Promise.allSettled([
      this.reader.ready(),
      this.writer.ready(),
    ]);
    if (write.status === "rejected") throw write.reason;
  }

  isWritable(): boolean {
    return this.writer.isWritable();
  }

  /** See {@link ToonPaidWriter.setMnemonic}. */
  setMnemonic(mnemonic: string): void {
    this.writer.setMnemonic(mnemonic);
  }

  async publish(
    event: RelayEvent,
    messages: PublishFailureMessages,
  ): Promise<RelayEvent> {
    try {
      const receipt = await this.writer.publish(event);
      // The fee is not incidental detail: on a paid network the user is owed
      // the number. Callers listen via `onPaidWrite`; this keeps it in the log
      // for the cases where nothing is listening yet.
      console.info(
        `[toon] paid write ${receipt.eventId} → ${receipt.destination} for ${formatFee(receipt)}`,
      );
      return event;
    } catch (error) {
      throw new Error(
        `${messages.sendErrorMessage} ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Dropped by design — see the class doc. */
  publishEphemeral(_event: RelayEvent): Promise<void> {
    return Promise.resolve();
  }

  subscribeLive(
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
  ): Promise<ToonSubscriptionDispose> {
    return this.reader.subscribeLive(filter, onEvent);
  }

  fetchEvents(filter: RelaySubscriptionFilter): Promise<RelayEvent[]> {
    return this.reader.fetchEvents(filter);
  }

  /** Observe what each write costs. Returns an unsubscribe. */
  onPaidWrite(listener: PaidWriteListener): () => void {
    return this.writer.onPaidWrite(listener);
  }

  /** The flat per-packet fee for the publish route, in base units. */
  quoteFee(): Promise<bigint> {
    return this.writer.quoteFee();
  }

  async close(): Promise<void> {
    this.reader.close();
    await this.writer.close();
  }
}
