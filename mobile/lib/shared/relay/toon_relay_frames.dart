import 'dart:convert';

/// Tolerant NIP-01 frame decoding for the TOON relay.
///
/// Mirrors `desktop/src/shared/api/toonRelayFrames.ts` and
/// `crates/buzz-cli/src/toon_relay.rs`: the devnet relay does not always
/// speak plain NIP-01 — an EVENT payload can arrive as a JSON *string*
/// containing the event JSON rather than as an inline object, and the whole
/// frame is sometimes double-encoded the same way. A reader that assumes one
/// encoding does not error on the other — it silently drops the frame (or,
/// for the EVENT payload case, crashes the caller that blindly casts it to a
/// map). Both encodings are decoded here, in a pure function, so the
/// tolerance is unit-tested rather than discovered on-device.
///
/// Every other frame shape (EOSE/CLOSED/OK/NOTICE/AUTH arity, extra or
/// missing trailing fields) is passed through byte-for-byte so downstream
/// handlers — which already have their own tolerant/fallback logic for
/// missing fields — see exactly what they saw before this decoder existed.

/// `jsonDecode` that also unwraps a value which is itself a JSON string.
///
/// One level of unwrapping only: a legitimately string-valued payload (a
/// NOTICE's message) must survive, so this stops as soon as the result is
/// not parseable as JSON.
dynamic parseMaybeDoubleEncoded(String raw) {
  dynamic parsed;
  try {
    parsed = jsonDecode(raw);
  } catch (_) {
    return null;
  }
  if (parsed is! String) return parsed;
  try {
    return jsonDecode(parsed);
  } catch (_) {
    return parsed;
  }
}

/// Shape-check an inbound payload before it is trusted as a Nostr event.
///
/// Returns a `Map<String, dynamic>` regardless of whether [payload] arrived
/// already decoded or as a (possibly double-encoded) JSON string, so callers
/// never need their own `as Map<String, dynamic>` cast.
Map<String, dynamic>? asRelayEventJson(dynamic payload) {
  final candidate = payload is String
      ? parseMaybeDoubleEncoded(payload)
      : payload;
  if (candidate is! Map) return null;

  if (candidate['id'] is! String) return null;
  if (candidate['pubkey'] is! String) return null;
  if (candidate['kind'] is! int) return null;
  if (candidate['content'] is! String) return null;
  if (candidate['created_at'] is! int) return null;
  if (candidate['tags'] is! List) return null;

  return Map<String, dynamic>.from(candidate);
}

/// Decode one inbound relay message into the NIP-01 array shape consumed by
/// [RelaySocket]/[RelaySessionNotifier]: `[type, ...rest]`.
///
/// Returns null for anything unrecognised — a malformed frame is not an
/// error the caller can act on, and the relay is entitled to send frames
/// this reader does not implement. For an `EVENT` frame, the payload slot is
/// normalized to a `Map<String, dynamic>` (decoding it if it arrived as a
/// JSON string) and shape-checked; the frame is dropped if that payload does
/// not look like a Nostr event.
List<dynamic>? decodeToonRelayFrame(String raw) {
  final frame = parseMaybeDoubleEncoded(raw);
  if (frame is! List || frame.isEmpty) return null;
  if (frame[0] is! String) return null;

  if (frame[0] == 'EVENT') {
    if (frame.length < 3) return null;
    final event = asRelayEventJson(frame[2]);
    if (event == null) return null;
    final normalized = List<dynamic>.from(frame);
    normalized[2] = event;
    return normalized;
  }

  return frame;
}
