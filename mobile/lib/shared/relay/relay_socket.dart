import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'nostr_models.dart';
import 'toon_relay_frames.dart';

/// Low-level websocket connection, optionally with NIP-42 authentication.
///
/// Handles the raw websocket lifecycle: connect, authenticate via NIP-42
/// challenge/response (skipped entirely in [SessionMode.toon] — see
/// [connect]), send/receive JSON frames, and disconnect.
///
/// Does NOT handle reconnection — that is [RelaySessionNotifier]'s job.
enum SocketState { disconnected, connecting, authenticating, connected }

class RelayAuthRejectedException implements Exception {
  final String message;

  const RelayAuthRejectedException(this.message);

  @override
  String toString() => 'Relay authentication rejected: $message';
}

Exception classifyRelayAuthFailure(String message) {
  if (message.startsWith('error:')) return Exception(message);
  return RelayAuthRejectedException(message);
}

class RelaySocket {
  final String _wsUrl;
  final String? _nsec;
  final SessionMode _sessionMode;
  final void Function(List<dynamic> message) _onMessage;
  final void Function() _onConnected;
  final void Function(Object? error) _onDisconnected;
  final WebSocketChannel Function(Uri uri) _channelFactory;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  SocketState _state = SocketState.disconnected;
  Completer<void>? _authCompleter;
  Timer? _authTimeout;
  String? _pendingAuthEventId;

  SocketState get state => _state;

  RelaySocket({
    required String wsUrl,
    required String? nsec,
    required void Function(List<dynamic> message) onMessage,
    required void Function() onConnected,
    required void Function(Object? error) onDisconnected,
    required SessionMode sessionMode,
    WebSocketChannel Function(Uri uri) channelFactory =
        WebSocketChannel.connect,
  }) : _wsUrl = wsUrl,
       _nsec = nsec,
       _sessionMode = sessionMode,
       _onMessage = onMessage,
       _onConnected = onConnected,
       _onDisconnected = onDisconnected,
       _channelFactory = channelFactory;

  /// Connect to the relay.
  ///
  /// In [SessionMode.legacy], completes NIP-42 authentication before
  /// resolving. In [SessionMode.toon], the relay speaks plain NIP-01 and
  /// never sends an AUTH challenge — waiting for one produced an 8s timeout
  /// followed by an infinite reconnect loop, so [SocketState.connected] is
  /// reached as soon as the websocket itself is open.
  Future<void> connect() async {
    if (_state != SocketState.disconnected) return;
    _state = SocketState.connecting;

    try {
      _channel = _channelFactory(Uri.parse(_wsUrl));
      await _channel!.ready;
    } catch (e) {
      _state = SocketState.disconnected;
      _onDisconnected(e);
      return;
    }

    // The channel may have been disposed while we were awaiting ready
    // (e.g. provider rebuild triggered dispose() concurrently).
    if (_channel == null) {
      _state = SocketState.disconnected;
      return;
    }

    _subscription = _channel!.stream.listen(
      _handleRawMessage,
      onError: (Object error) {
        _failAuth(error);
        _resetConnection();
        _onDisconnected(error);
      },
      onDone: () {
        _failAuth(null);
        _resetConnection();
        _onDisconnected(null);
      },
    );

    if (_sessionMode == SessionMode.toon) {
      _state = SocketState.connected;
      _onConnected();
      return;
    }

    _state = SocketState.authenticating;
    _authCompleter = Completer<void>();

    // Wait for auth to complete (or timeout).
    _authTimeout = Timer(const Duration(seconds: 8), () {
      if (_authCompleter != null && !_authCompleter!.isCompleted) {
        _authCompleter!.completeError(
          TimeoutException('NIP-42 auth timed out after 8s'),
        );
      }
    });

    try {
      await _authCompleter!.future;
      _authTimeout?.cancel();
      _state = SocketState.connected;
      _onConnected();
    } catch (e) {
      _authTimeout?.cancel();
      await disconnect();
      _onDisconnected(e);
    }
  }

  /// Send a raw JSON array over the websocket.
  void send(List<dynamic> payload) {
    _channel?.sink.add(jsonEncode(payload));
  }

  /// Gracefully close the connection.
  Future<void> disconnect() async {
    _resetConnection();
    final channel = _channel;
    _channel = null;
    if (channel != null) {
      await channel.sink.close();
    }
  }

  void dispose() {
    _resetConnection();
    _channel?.sink.close();
    _channel = null;
  }

  void _resetConnection() {
    _state = SocketState.disconnected;
    _subscription?.cancel();
    _subscription = null;
    _authTimeout?.cancel();
    _authTimeout = null;
    _pendingAuthEventId = null;
  }

  void _failAuth(Object? error) {
    if (_authCompleter != null && !_authCompleter!.isCompleted) {
      _authCompleter!.completeError(error ?? Exception('Connection closed'));
    }
  }

  void _handleRawMessage(dynamic raw) {
    final String text;
    if (raw is String) {
      text = raw;
    } else {
      return; // Binary frames are not part of the Nostr protocol.
    }

    final data = decodeToonRelayFrame(text);
    if (data == null) return; // Malformed or unrecognised frame.

    final type = data[0] as String;

    switch (type) {
      case 'AUTH':
        _handleAuthChallenge(data);
      case 'OK':
        _handleOk(data);
      default:
        // Pass EVENT, EOSE, NOTICE, etc. upstream.
        _onMessage(data);
    }
  }

  /// Handle the relay's AUTH challenge: sign a kind:22242 event and respond.
  void _handleAuthChallenge(List<dynamic> data) {
    if (data.length < 2) return;
    final challenge = data[1] as String;

    if (_nsec == null) {
      _failAuth(Exception('No nsec available for NIP-42 auth'));
      return;
    }

    try {
      // Decode bech32 nsec to hex private key.
      final privkeyHex = nostr.Nip19.decode(payload: _nsec).data;
      if (privkeyHex.isEmpty) {
        _failAuth(Exception('Invalid nsec'));
        return;
      }

      // Build the auth tags.
      final tags = <List<String>>[
        ['relay', _wsUrl],
        ['challenge', challenge],
      ];

      // Create and sign the kind:22242 AUTH event.
      final event = nostr.Event.from(
        kind: EventKind.auth,
        content: '',
        tags: tags,
        secretKey: privkeyHex,
      );

      _pendingAuthEventId = event.id;
      send(['AUTH', event.toMap()]);
    } catch (e) {
      _failAuth(e);
    }
  }

  @visibleForTesting
  void debugHandleOkForTest(List<dynamic> data) => _onMessage(data);

  /// Handle OK frames. During auth, complete the auth flow.
  void _handleOk(List<dynamic> data) {
    if (data.length < 3) return;
    final eventId = data[1] as String;
    final accepted = data[2] as bool;

    // Check if this OK is for our pending AUTH event.
    if (_pendingAuthEventId != null && eventId == _pendingAuthEventId) {
      _pendingAuthEventId = null;
      if (accepted) {
        if (_authCompleter != null && !_authCompleter!.isCompleted) {
          _authCompleter!.complete();
        }
      } else {
        final message = data.length > 3
            ? data[3] as String
            : 'Auth rejected by relay';
        _failAuth(classifyRelayAuthFailure(message));
      }
      return;
    }

    // Pass non-auth OK frames upstream for pending event tracking.
    _onMessage(data);
  }
}
