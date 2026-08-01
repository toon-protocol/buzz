import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getEventTransport } from "@/shared/api/eventTransport";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The frontend half of the Rust-side write bridge (buzz#27).
 *
 * `src-tauri`'s `event_transport::BridgeTransport` is what a Rust write
 * site (`send_channel_message`, `add_reaction`, huddle STT, a persona/team
 * snapshot restore, …) goes through when `BUZZ_TRANSPORT=toon`: Rust has no
 * payment client of its own, so instead of reimplementing ILP-over-HTTP it
 * signs the event, guards it, and asks the frontend to carry it through
 * whichever transport `installSelectedTransport()` already installed — the
 * very seam `eventTransport.ts` exists for. This module is the frontend side
 * of that ask: listen for the request, publish it, report back.
 *
 * The event Rust hands over is already fully signed and, for encrypted
 * channels (buzz#12 encrypts above the TS seam), already carries its
 * encrypted `content` — this bridge treats it as opaque bytes and never
 * inspects or re-derives anything from it beyond parsing the outer NIP-01
 * envelope.
 *
 * Known limitation: a Rust write attempted before this listener is
 * registered (i.e. before `main.tsx`'s bootstrap has resolved
 * `installSelectedTransport()` and called `installRustWriteBridge()`) has
 * nothing listening on the other end and times out on the Rust side rather
 * than publishing. In practice every Rust write site fires from a user
 * action taken well after the window is up.
 */

const BRIDGE_REQUEST_EVENT = "buzz://rust-write-bridge-request";
const REPORT_COMMAND = "report_bridged_write_result";

/** Payload shape emitted by `event_transport::bridge::BridgeTransport`. */
type RustWriteBridgeRequest = {
  requestId: string;
  eventJson: string;
};

async function reportResult(
  requestId: string,
  error: string | null,
): Promise<void> {
  try {
    await invoke(REPORT_COMMAND, { requestId, error });
  } catch (reportError) {
    // Nothing else can be done: the Rust side has its own timeout and will
    // surface an error to its caller once it elapses.
    console.error(
      "[rustWriteBridge] failed to report a bridged write result",
      reportError,
    );
  }
}

async function handleBridgeRequest({
  requestId,
  eventJson,
}: RustWriteBridgeRequest): Promise<void> {
  let event: RelayEvent;
  try {
    event = JSON.parse(eventJson) as RelayEvent;
  } catch (parseError) {
    await reportResult(
      requestId,
      `bridged event was not valid JSON: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`,
    );
    return;
  }

  try {
    const transport = getEventTransport();
    await transport.ready();
    await transport.publish(event, {
      timeoutMessage: "Bridged write timed out",
      sendErrorMessage: "Bridged write failed",
    });
    await reportResult(requestId, null);
  } catch (error) {
    await reportResult(
      requestId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Register the bridge listener. Called once from `main.tsx`, after
 * `installSelectedTransport()` has resolved so `getEventTransport()` already
 * returns whichever transport this run selected, and before the app renders.
 *
 * Never throws: a bridge that fails to install means Rust-side writes will
 * time out and report an error on that side, which is the "no silent drops"
 * contract this module exists to uphold — it is not a reason to fail app
 * startup.
 */
export async function installRustWriteBridge(): Promise<UnlistenFn | null> {
  try {
    return await listen<RustWriteBridgeRequest>(
      BRIDGE_REQUEST_EVENT,
      (event) => {
        void handleBridgeRequest(event.payload);
      },
    );
  } catch (error) {
    console.warn("[rustWriteBridge] could not install the write bridge", error);
    return null;
  }
}
