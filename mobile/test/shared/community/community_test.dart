import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/shared/community/community.dart';
import 'package:buzz/shared/relay/nostr_models.dart' show SessionMode;

void main() {
  group('Community.sessionMode', () {
    test('defaults to legacy when not specified', () {
      final community = Community.create(
        name: 'Test',
        relayUrl: 'https://relay.example',
      );

      expect(community.sessionMode, SessionMode.legacy);
    });

    test('round-trips toon mode through JSON', () {
      final community = Community.create(
        name: 'Test',
        relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
        sessionMode: SessionMode.toon,
      );

      final decoded = Community.fromJson(community.toJson());

      expect(decoded.sessionMode, SessionMode.toon);
    });

    test(
      'a community persisted before this field existed defaults to legacy',
      () {
        final legacyJson = {
          'id': 'abc',
          'name': 'Old Community',
          'relayUrl': 'https://relay.example',
          'addedAt': DateTime(2024).toIso8601String(),
        };

        final decoded = Community.fromJson(legacyJson);

        expect(decoded.sessionMode, SessionMode.legacy);
      },
    );

    test('copyWith can switch session mode without touching other fields', () {
      final community = Community.create(
        name: 'Test',
        relayUrl: 'https://relay.example',
      );

      final switched = community.copyWith(sessionMode: SessionMode.toon);

      expect(switched.sessionMode, SessionMode.toon);
      expect(switched.name, community.name);
      expect(switched.relayUrl, community.relayUrl);
    });

    test('legacy mode omits sessionMode from the serialized JSON', () {
      final community = Community.create(
        name: 'Test',
        relayUrl: 'https://relay.example',
      );

      expect(community.toJson().containsKey('sessionMode'), isFalse);
    });
  });
}
