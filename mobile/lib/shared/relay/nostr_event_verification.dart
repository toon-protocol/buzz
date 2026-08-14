import 'package:nostr/nostr.dart' as nostr;

import 'nostr_models.dart';

/// Verify a NIP-01 event's `id` (content hash) and `sig` (BIP-340 Schnorr)
/// client-side.
///
/// The TOON relay skips signature verification for paid ephemeral kinds
/// (relay `write-handler.ts:162-170`) — its trust model is clients verify
/// themselves, unlike the legacy private relay which never forwards an event
/// it has not already checked. This is only meant to be called in
/// [SessionMode.toon]; legacy sessions can trust the relay the way they
/// always have.
///
/// Never throws: a malformed event (missing fields, wrong types) is treated
/// as invalid rather than propagating an exception into the caller's stream
/// handling.
bool isNostrEventSignatureValid(NostrEvent event) {
  try {
    return nostr.Event.fromMap(event.toJson(), verify: false).isValid();
  } catch (_) {
    return false;
  }
}
