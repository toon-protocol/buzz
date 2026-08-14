import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:buzz/shared/relay/relay.dart';

NostrEvent _signedEvent(nostr.Keys keychain, {String content = 'hello'}) {
  final event = nostr.Event.from(
    kind: 9,
    content: content,
    secretKey: keychain.secret,
  );
  return NostrEvent.fromJson(event.toMap());
}

void main() {
  group('isNostrEventSignatureValid', () {
    test('a genuinely signed event passes', () {
      final event = _signedEvent(nostr.Keys.generate());

      expect(isNostrEventSignatureValid(event), isTrue);
    });

    test('an event with a bad signature is dropped', () {
      final event = _signedEvent(nostr.Keys.generate());
      final tampered = NostrEvent(
        id: event.id,
        pubkey: event.pubkey,
        createdAt: event.createdAt,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: 'f' * 128,
      );

      expect(isNostrEventSignatureValid(tampered), isFalse);
    });

    test('an event with a mismatched id is dropped', () {
      final event = _signedEvent(nostr.Keys.generate());
      final tampered = NostrEvent(
        id: 'f' * 64,
        pubkey: event.pubkey,
        createdAt: event.createdAt,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
      );

      expect(isNostrEventSignatureValid(tampered), isFalse);
    });

    test('tampering with the content invalidates the id hash', () {
      final event = _signedEvent(nostr.Keys.generate());
      final tampered = NostrEvent(
        id: event.id,
        pubkey: event.pubkey,
        createdAt: event.createdAt,
        kind: event.kind,
        tags: event.tags,
        content: 'tampered content',
        sig: event.sig,
      );

      expect(isNostrEventSignatureValid(tampered), isFalse);
    });

    test('a structurally malformed event is dropped rather than thrown', () {
      const event = NostrEvent(
        id: 'not-hex',
        pubkey: 'not-hex',
        createdAt: 0,
        kind: 9,
        tags: [],
        content: '',
        sig: 'not-hex',
      );

      expect(isNostrEventSignatureValid(event), isFalse);
    });
  });
}
