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
import {
  KIND_HUDDLE_AUDIO_FRAME,
  KIND_PRESENCE,
} from "@/shared/constants/kinds";

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
 * - **Ephemeral writes ride the free lane, not the paid one.**
 *   `publishEphemeral` carries typing indicators and (via `publish`'s
 *   kind:20001 special-case below) presence heartbeats to the zero-priced
 *   route relay#129 terminates (toon-meta#393 epic E2/E3) — no channel, no
 *   claim, no per-packet fee. Never rejects, per the seam's own contract for
 *   droppable events: a refusal is swallowed rather than surfaced, same as
 *   the relay transport's `publishEphemeralEvent`. A connector predating the
 *   lane (no route for `ephemeralDestination`) degrades to the same silent
 *   no-op these kinds got before the lane existed — see
 *   `ToonPaidWriter.publishEphemeral`.
 * - **The Rust write path bridges in, rather than calling this class
 *   directly.** Threaded replies, media, and custom-emoji messages are built
 *   and signed in `src-tauri` (see `eventTransport.ts`). As of buzz#27, when
 *   `BUZZ_TRANSPORT=toon` those writes are handed to whichever transport is
 *   active here over `rustWriteBridge.ts` — this class included — instead of
 *   going nowhere.
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
    // toon-meta#393: presence rides the same free-ephemeral-lane path typing
    // already does, rather than the paid path below — see the class doc.
    if (event.kind === KIND_PRESENCE) {
      await this.publishEphemeral(event);
      return event;
    }

    try {
      const receipt = await this.writer.publish(event);
      // The fee is not incidental detail: on a paid network the user is owed
      // the number. Callers listen via `onPaidWrite`; this keeps it in the log
      // for the cases where nothing is listening yet. Huddle audio frames are
      // the one exception — 50 paid writes/sec of console I/O would be its
      // own renderer load, and the huddle surface already carries the cost
      // (per-minute estimate before joining, buzz#23 stage 3).
      if (event.kind !== KIND_HUDDLE_AUDIO_FRAME) {
        console.info(
          `[toon] paid write ${receipt.eventId} → ${receipt.destination} for ${formatFee(receipt)}`,
        );
      }
      return event;
    } catch (error) {
      throw new Error(
        `${messages.sendErrorMessage} ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Publish onto the free ephemeral lane — see the class doc. Never rejects:
   * a refusal (including "this connector predates the lane") is loss the
   * caller has already accepted by using this method, same contract the
   * relay transport's `publishEphemeralEvent` keeps (every call site already
   * fire-and-forgets this with its own `.catch(() => {})`).
   */
  async publishEphemeral(event: RelayEvent): Promise<void> {
    try {
      await this.writer.publishEphemeral(event);
    } catch (error) {
      console.warn("[toon] ephemeral write dropped", error);
    }
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

  /**
   * The paying half, for the media seam.
   *
   * Media does not travel as an event, so it cannot ride `publish` — but it is
   * paid for out of the same channel by the same identity, and a second client
   * would mean a second channel and a split nonce sequence. The media uploader
   * therefore borrows this writer rather than building its own.
   */
  getPaidWriter(): ToonPaidWriter {
    return this.writer;
  }

  async close(): Promise<void> {
    this.reader.close();
    await this.writer.close();
  }
}
