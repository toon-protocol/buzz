import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:buzz/shared/relay/relay.dart';

void main() {
  group('RelaySocket', () {
    test(
      'toon mode reaches connected without waiting for an AUTH challenge',
      () async {
        final server = await _TestRelay.start((_) {});
        addTearDown(server.close);
        final socket = RelaySocket(
          wsUrl: server.url,
          nsec: null,
          onMessage: (_) {},
          onConnected: () {},
          onDisconnected: (_) {},
          sessionMode: SessionMode.toon,
        );
        addTearDown(socket.disconnect);

        await socket.connect().timeout(const Duration(seconds: 2));

        expect(socket.state, SocketState.connected);
      },
    );

    test(
      'toon mode ignores an AUTH challenge the relay sends anyway',
      () async {
        final server = await _TestRelay.start((webSocket) {
          webSocket.add(jsonEncode(['AUTH', 'challenge']));
        });
        addTearDown(server.close);
        final socket = RelaySocket(
          wsUrl: server.url,
          nsec: null,
          onMessage: (_) {},
          onConnected: () {},
          onDisconnected: (_) {},
          sessionMode: SessionMode.toon,
        );
        addTearDown(socket.disconnect);

        await socket.connect().timeout(const Duration(seconds: 2));

        expect(socket.state, SocketState.connected);
      },
    );

    test('legacy mode still answers a NIP-42 AUTH challenge', () async {
      final keychain = nostr.Keys.generate();
      final authReceived = Completer<List<dynamic>>();
      final server = await _TestRelay.start((webSocket) async {
        webSocket.add(jsonEncode(['AUTH', 'challenge']));
        final auth =
            jsonDecode(await webSocket.first as String) as List<dynamic>;
        authReceived.complete(auth);
        final event = auth[1] as Map<String, dynamic>;
        webSocket.add(jsonEncode(['OK', event['id'], true, 'authenticated']));
      });
      addTearDown(server.close);
      final socket = RelaySocket(
        wsUrl: server.url,
        nsec: keychain.nsec,
        onMessage: (_) {},
        onConnected: () {},
        onDisconnected: (_) {},
        sessionMode: SessionMode.legacy,
      );
      addTearDown(socket.disconnect);

      await socket.connect().timeout(const Duration(seconds: 2));

      expect(socket.state, SocketState.connected);
      expect((await authReceived.future).first, 'AUTH');
    });

    test(
      'legacy mode never reaches connected while the relay sends no AUTH '
      '(regression guard for the toon-mode branch)',
      () async {
        final server = await _TestRelay.start((_) {});
        addTearDown(server.close);
        final socket = RelaySocket(
          wsUrl: server.url,
          nsec: null,
          onMessage: (_) {},
          onConnected: () {},
          onDisconnected: (_) {},
          sessionMode: SessionMode.legacy,
        );
        addTearDown(socket.disconnect);

        // The 8s NIP-42 timeout is not overridable, so this asserts the
        // socket is still (correctly) stuck authenticating shortly after
        // connecting rather than waiting out the full timeout.
        unawaited(socket.connect());
        await Future<void>.delayed(const Duration(milliseconds: 100));

        expect(socket.state, SocketState.authenticating);
      },
    );

    test(
      'a double-encoded EVENT frame is decoded and the stream survives a '
      'malformed frame either side of it',
      () async {
        final received = <List<dynamic>>[];
        final server = await _TestRelay.start((webSocket) async {
          webSocket.add('not json at all');
          webSocket.add(
            jsonEncode([
              'EVENT',
              'sub',
              jsonEncode({
                'id': 'a' * 64,
                'pubkey': 'b' * 64,
                'created_at': 1700000000,
                'kind': 9,
                'tags': <List<String>>[],
                'content': 'hello',
                'sig': 'c' * 128,
              }),
            ]),
          );
          webSocket.add(jsonEncode(['EOSE', 'sub']));
        });
        addTearDown(server.close);
        final socket = RelaySocket(
          wsUrl: server.url,
          nsec: null,
          onMessage: received.add,
          onConnected: () {},
          onDisconnected: (_) {},
          sessionMode: SessionMode.toon,
        );
        addTearDown(socket.disconnect);

        await socket.connect().timeout(const Duration(seconds: 2));
        final deadline = DateTime.now().add(const Duration(seconds: 2));
        while (received.length < 2 && DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }

        expect(received.length, greaterThanOrEqualTo(2));
        expect(received[0][0], 'EVENT');
        expect(received[0][2], isA<Map<String, dynamic>>());
        expect((received[0][2] as Map<String, dynamic>)['id'], 'a' * 64);
        expect(received[1], ['EOSE', 'sub']);
      },
    );
  });
}

class _TestRelay {
  final HttpServer _server;
  final List<WebSocket> _sockets = [];

  _TestRelay._(this._server);

  String get url => 'ws://${_server.address.host}:${_server.port}';

  static Future<_TestRelay> start(
    FutureOr<void> Function(WebSocket socket) onConnected,
  ) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final relay = _TestRelay._(server);
    server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      relay._sockets.add(socket);
      await onConnected(socket);
    });
    return relay;
  }

  Future<void> close() async {
    for (final socket in _sockets) {
      await socket.close();
    }
    await _server.close(force: true);
  }
}
