import type {
  EventTransport,
  PublishFailureMessages,
} from "@/shared/api/eventTransport";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayClient } from "@/shared/api/relayClientSession";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The transport seam's only implementation: the NIP-42 authenticated relay
 * session the app has always used. It owns nothing of its own — every method
 * delegates to the shared `RelayClient`, which also serves reads — so this
 * file is purely the shape adapter between the seam and the relay session.
 */
export class RelayEventTransport implements EventTransport {
  private readonly client: RelayClient;

  constructor(client: RelayClient) {
    this.client = client;
  }

  ready(): Promise<void> {
    return this.client.ensureConnected();
  }

  isWritable(): boolean {
    return this.client.isWritable();
  }

  publish(
    event: RelayEvent,
    messages: PublishFailureMessages,
  ): Promise<RelayEvent> {
    return this.client.publishEvent(
      event,
      messages.timeoutMessage,
      messages.sendErrorMessage,
    );
  }

  publishEphemeral(event: RelayEvent): Promise<void> {
    return this.client.publishEphemeralEvent(event);
  }
}

export const relayEventTransport = new RelayEventTransport(relayClient);
