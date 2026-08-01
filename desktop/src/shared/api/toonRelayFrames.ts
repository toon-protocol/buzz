import type { RelayEvent } from "@/shared/api/types";

/**
 * NIP-01 frame decoding for the TOON relay.
 *
 * Separate from the relay session's own parser because the TOON devnet relay
 * does not always speak plain NIP-01: an EVENT payload may arrive as a JSON
 * *string* containing the event JSON rather than as an inline object, and the
 * whole frame is sometimes double-encoded the same way. A reader that assumes
 * one encoding does not error on the other — it silently sees no events, which
 * presents as an empty channel with nothing in the log. Both encodings are
 * therefore decoded here, in a pure function, so the tolerance is unit-tested
 * rather than discovered on devnet.
 */

/** A decoded relay frame, or null when the bytes were not one we act on. */
export type ToonRelayFrame =
  | { type: "EVENT"; subscriptionId: string; event: RelayEvent }
  | { type: "EOSE"; subscriptionId: string }
  | { type: "CLOSED"; subscriptionId: string; message: string }
  | { type: "OK"; eventId: string; accepted: boolean; message: string }
  | { type: "NOTICE"; message: string }
  | null;

/**
 * JSON.parse that also unwraps a value which is itself a JSON string.
 *
 * One level of unwrapping only: a legitimately string-valued payload (a
 * NOTICE's message) must survive, so this stops as soon as the result is not
 * parseable as JSON.
 */
function parseMaybeDoubleEncoded(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "string") return parsed;
  try {
    return JSON.parse(parsed);
  } catch {
    return parsed;
  }
}

/** Shape-check an inbound payload before it is trusted as a Nostr event. */
function asRelayEvent(payload: unknown): RelayEvent | null {
  const candidate =
    typeof payload === "string" ? parseMaybeDoubleEncoded(payload) : payload;
  if (candidate === null || typeof candidate !== "object") return null;

  const record = candidate as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  if (typeof record.pubkey !== "string") return null;
  if (typeof record.kind !== "number") return null;
  if (typeof record.content !== "string") return null;
  if (typeof record.created_at !== "number") return null;
  if (!Array.isArray(record.tags)) return null;

  return candidate as RelayEvent;
}

/**
 * Decode one inbound relay message.
 *
 * Returns null for anything unrecognised — a malformed frame is not an error
 * the caller can act on, and the relay is entitled to send frames this reader
 * does not implement.
 */
export function decodeToonRelayFrame(raw: string): ToonRelayFrame {
  const frame = parseMaybeDoubleEncoded(raw);
  if (!Array.isArray(frame) || frame.length === 0) return null;

  const [type, ...rest] = frame as unknown[];

  if (type === "EVENT" && typeof rest[0] === "string") {
    const event = asRelayEvent(rest[1]);
    return event ? { type: "EVENT", subscriptionId: rest[0], event } : null;
  }
  if (type === "EOSE" && typeof rest[0] === "string") {
    return { type: "EOSE", subscriptionId: rest[0] };
  }
  if (type === "CLOSED" && typeof rest[0] === "string") {
    return {
      type: "CLOSED",
      subscriptionId: rest[0],
      message: typeof rest[1] === "string" ? rest[1] : "",
    };
  }
  if (type === "OK" && typeof rest[0] === "string") {
    return {
      type: "OK",
      eventId: rest[0],
      accepted: rest[1] === true,
      message: typeof rest[2] === "string" ? rest[2] : "",
    };
  }
  if (type === "NOTICE") {
    return {
      type: "NOTICE",
      message: typeof rest[0] === "string" ? rest[0] : "",
    };
  }
  return null;
}
