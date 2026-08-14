import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/shared/relay/toon_relay_frames.dart';

final _event = {
  'id': 'a' * 64,
  'pubkey': 'b' * 64,
  'created_at': 1785400000,
  'kind': 9,
  'tags': [
    ['h', 'channel-1'],
  ],
  'content': 'hello',
  'sig': 'c' * 128,
};

void main() {
  group('decodeToonRelayFrame', () {
    test('decodes a standard NIP-01 EVENT frame', () {
      final frame = decodeToonRelayFrame(jsonEncode(['EVENT', 'sub', _event]));

      expect(frame, ['EVENT', 'sub', _event]);
    });

    test('decodes an EVENT whose payload is a JSON string', () {
      // The devnet relay has been observed serving the event this way: the
      // frame is a normal array, but slot 2 holds the event JSON as a string.
      final raw = jsonEncode(['EVENT', 'sub', jsonEncode(_event)]);

      final frame = decodeToonRelayFrame(raw);

      expect(frame?[0], 'EVENT');
      expect(frame?[2], _event);
    });

    test('decodes an EVENT whose whole frame is a JSON string', () {
      final raw = jsonEncode(jsonEncode(['EVENT', 'sub', _event]));

      final frame = decodeToonRelayFrame(raw);

      expect(frame, ['EVENT', 'sub', _event]);
    });

    test('decodes a doubly-encoded frame carrying a doubly-encoded event', () {
      final raw = jsonEncode(jsonEncode(['EVENT', 'sub', jsonEncode(_event)]));

      final frame = decodeToonRelayFrame(raw);

      expect(frame?[0], 'EVENT');
      expect(frame?[2], _event);
    });

    test('rejects an EVENT payload that is not event-shaped', () {
      // The failure this guards is a crash downstream, not a throw here:
      // without the shape check a bare string sails through and the
      // session's `data[2] as Map<String, dynamic>` cast throws.
      final raw = jsonEncode(['EVENT', 'sub', 'not-an-event']);

      expect(decodeToonRelayFrame(raw), isNull);
    });

    test('rejects an event missing required NIP-01 fields', () {
      final missingKind = {..._event, 'kind': '9'};
      final noSig = Map<String, dynamic>.from(_event)..remove('sig');

      expect(
        decodeToonRelayFrame(jsonEncode(['EVENT', 'sub', missingKind])),
        isNull,
      );
      // `sig` is not required by this decoder — the relay only forwards
      // signed events, and the app's own optimistic rows carry an empty one.
      expect(
        decodeToonRelayFrame(jsonEncode(['EVENT', 'sub', noSig]))?[0],
        'EVENT',
      );
    });

    test('an EVENT frame with too few elements decodes to null', () {
      expect(decodeToonRelayFrame(jsonEncode(['EVENT', 'sub'])), isNull);
      expect(decodeToonRelayFrame(jsonEncode(['EVENT'])), isNull);
    });

    test('passes EOSE, CLOSED, OK, NOTICE and AUTH through untouched', () {
      expect(decodeToonRelayFrame(jsonEncode(['EOSE', 'sub'])), [
        'EOSE',
        'sub',
      ]);
      expect(
        decodeToonRelayFrame(jsonEncode(['CLOSED', 'sub', 'rate-limited'])),
        ['CLOSED', 'sub', 'rate-limited'],
      );
      // Arity is preserved exactly: a CLOSED frame with no message keeps its
      // original length so the session's own fallback-message logic
      // (`data.length >= 3`) still applies.
      expect(decodeToonRelayFrame(jsonEncode(['CLOSED', 'sub'])), [
        'CLOSED',
        'sub',
      ]);
      expect(decodeToonRelayFrame(jsonEncode(['OK', 'abc', true, ''])), [
        'OK',
        'abc',
        true,
        '',
      ]);
      expect(decodeToonRelayFrame(jsonEncode(['NOTICE', 'hi'])), [
        'NOTICE',
        'hi',
      ]);
      expect(decodeToonRelayFrame(jsonEncode(['AUTH', 'challenge'])), [
        'AUTH',
        'challenge',
      ]);
    });

    test('returns null for junk rather than throwing', () {
      expect(decodeToonRelayFrame('not json'), isNull);
      expect(decodeToonRelayFrame('[]'), isNull);
      expect(decodeToonRelayFrame('{}'), isNull);
      expect(decodeToonRelayFrame('"just a string"'), isNull);
      expect(decodeToonRelayFrame(jsonEncode([1, 2, 3])), isNull);
    });
  });
}
