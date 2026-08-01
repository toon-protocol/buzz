import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { decodeToonRelayFrame } from "@/shared/api/toonRelayFrames";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Free reads from a TOON relay.
 *
 * TOON charges for writes and nothing for reads, so this side needs none of
 * the machinery the paid side does: no channel, no claim, no connector. It is
 * a plain NIP-01 client over a WebSocket, deliberately kept separate from the
 * relay session in `relayClientSession.ts` — that one authenticates with
 * NIP-42, drives the Tauri websocket plugin, and treats an auth rejection as
 * terminal, none of which applies to an unauthenticated public read.
 *
 * One socket serves every subscription, multiplexed by subscription id the way
 * NIP-01 intends, and it reconnects with backoff while any subscription is
 * still open. `REQ`s are replayed on reconnect so a dropped socket costs a gap
 * in the tail rather than a dead channel.
 */

/** The slice of `WebSocket` this reader uses, so tests can supply their own. */
export interface ToonSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type ToonSocketFactory = (url: string) => ToonSocket;

/** Unsubscribe from a live subscription. */
export type ToonSubscriptionDispose = () => Promise<void>;

type Subscription = {
  filter: RelaySubscriptionFilter;
  onEvent: (event: RelayEvent) => void;
  /** Resolved on the first EOSE (or the readiness deadline), like the relay session. */
  resolveReady: (() => void) | null;
};

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Matches the relay session: a subscription is usable before EOSE arrives. */
const READY_FALLBACK_MS = 250;
const QUERY_TIMEOUT_MS = 25_000;

function defaultSocketFactory(url: string): ToonSocket {
  return new WebSocket(url) as unknown as ToonSocket;
}

export class ToonRelayReader {
  private readonly url: string;
  private readonly createSocket: ToonSocketFactory;
  private readonly subscriptions = new Map<string, Subscription>();
  private socket: ToonSocket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private counter = 0;

  constructor(
    url: string,
    createSocket: ToonSocketFactory = defaultSocketFactory,
  ) {
    this.url = url;
    this.createSocket = createSocket;
  }

  /** Whether a REQ can go out without connecting first. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Bring the socket up, or resolve immediately when it already is. */
  async ready(): Promise<void> {
    if (this.connected) return;
    this.closed = false;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Attach a live subscription. Resolves once the relay has caught the caller
   * up (EOSE) or the readiness deadline passes, whichever comes first.
   */
  async subscribeLive(
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
  ): Promise<ToonSubscriptionDispose> {
    await this.ready();

    const subscriptionId = this.nextSubscriptionId("live");
    const ready = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, READY_FALLBACK_MS);
      this.subscriptions.set(subscriptionId, {
        filter,
        onEvent,
        resolveReady: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });

    this.sendReq(subscriptionId, filter);
    await ready;

    return async () => {
      this.subscriptions.delete(subscriptionId);
      this.send(["CLOSE", subscriptionId]);
    };
  }

  /** One-shot query: collect until EOSE, then close the subscription. */
  async fetchEvents(filter: RelaySubscriptionFilter): Promise<RelayEvent[]> {
    await this.ready();

    const subscriptionId = this.nextSubscriptionId("query");
    const events: RelayEvent[] = [];

    return new Promise<RelayEvent[]>((resolve) => {
      // A timeout resolves with what arrived rather than rejecting: a partial
      // page of history is worth more to the caller than an error, and the
      // live subscription will fill the tail regardless.
      const timer = setTimeout(() => settle(), QUERY_TIMEOUT_MS);
      const settle = () => {
        clearTimeout(timer);
        this.subscriptions.delete(subscriptionId);
        this.send(["CLOSE", subscriptionId]);
        resolve(events);
      };

      this.subscriptions.set(subscriptionId, {
        filter,
        onEvent: (event) => events.push(event),
        resolveReady: settle,
      });
      this.sendReq(subscriptionId, filter);
    });
  }

  /** Drop every subscription and stop reconnecting. */
  close(): void {
    this.closed = true;
    this.subscriptions.clear();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const socket = this.createSocket(this.url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        // Replay every still-open REQ so a reconnect restores the tail.
        for (const [id, sub] of this.subscriptions)
          this.sendReq(id, sub.filter);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });

      const down = () => {
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        // Resolve rather than reject: `ready()` promises an attempt, not a
        // connection, and the caller's subscription is queued for replay.
        if (!settled) {
          settled = true;
          resolve();
        }
        this.scheduleReconnect();
      };
      socket.addEventListener("close", down);
      socket.addEventListener("error", down);
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    if (this.subscriptions.size === 0) return;

    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ready();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    const raw =
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? new TextDecoder().decode(data)
          : null;
    if (raw === null) return;

    const frame = decodeToonRelayFrame(raw);
    if (frame === null) return;

    if (frame.type === "EVENT") {
      this.subscriptions.get(frame.subscriptionId)?.onEvent(frame.event);
      return;
    }
    if (frame.type === "EOSE") {
      const sub = this.subscriptions.get(frame.subscriptionId);
      sub?.resolveReady?.();
      if (sub) sub.resolveReady = null;
      return;
    }
    if (frame.type === "CLOSED") {
      // The relay ended the subscription; stop tracking it so a reconnect
      // does not replay a REQ the relay has already refused.
      this.subscriptions.get(frame.subscriptionId)?.resolveReady?.();
      this.subscriptions.delete(frame.subscriptionId);
    }
  }

  /** Subscription ids are per-reader, so they only need local uniqueness. */
  private nextSubscriptionId(kind: "live" | "query"): string {
    this.counter += 1;
    return `toon-${kind}-${this.counter}`;
  }

  private sendReq(
    subscriptionId: string,
    filter: RelaySubscriptionFilter,
  ): void {
    this.send(["REQ", subscriptionId, filter]);
  }

  private send(payload: unknown[]): void {
    if (!this.connected || this.socket === null) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // A send on a socket that died between the check and the write is a
      // reconnect, not a caller error: the REQ is replayed on `open`.
    }
  }
}
