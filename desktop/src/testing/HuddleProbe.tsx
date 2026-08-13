import * as React from "react";

import { useHuddle } from "@/features/huddle/HuddleContext";
import { relayClient } from "@/shared/api/relayClient";
import { useIdentityQuery } from "@/shared/api/hooks";
import { joinChannel } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";

const KIND_HUDDLE_STARTED = 48100;
const KIND_HUDDLE_ENDED = 48103;

/**
 * Headless driver for the buzz#23 AC1 two-desktop huddle run. Compiled in
 * only when VITE_HUDDLE_PROBE=1; renders nothing. The instance whose pubkey
 * matches VITE_PROBE_A_PUBKEY starts a huddle in VITE_PROBE_CHANNEL_ID; any
 * other instance watches the channel's huddle lifecycle events and joins the
 * huddle it sees. Progress is mirrored to document.title (screenshot-
 * readable), the console, and window.__HUDDLE_PROBE__ — everything else is
 * the app's real path: getUserMedia → worklet → push_audio_pcm → Opus →
 * relay → jitter → playback.
 */
export function HuddleProbe() {
  const identity = useIdentityQuery();
  const {
    startHuddle,
    joinHuddle,
    micConnected,
    activeEphemeralChannelId,
    huddleError,
    activeSpeakers,
  } = useHuddle();

  const channelId = import.meta.env.VITE_PROBE_CHANNEL_ID as string;
  const aPubkey = import.meta.env.VITE_PROBE_A_PUBKEY as string;

  const pubkey = identity.data?.pubkey ?? null;
  const role = pubkey === null ? null : pubkey === aPubkey ? "A" : "B";

  const [status, setStatus] = React.useState("boot");
  const [seenHuddle, setSeenHuddle] = React.useState<string | null>(null);
  const [diag, setDiag] = React.useState("gum:?");
  const [joined, setJoined] = React.useState(false);
  const attempted = React.useRef(false);

  // Standalone capture diagnostic, independent of the huddle path: does the
  // bare minimum getUserMedia work in this webview at all?
  React.useEffect(() => {
    void (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((d) => d.kind === "audioinput").length;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const label = stream.getAudioTracks()[0]?.label ?? "?";
        for (const track of stream.getTracks()) track.stop();
        setDiag(`gum:ok in=${inputs} "${label}"`);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "Error";
        setDiag(
          `gum:FAIL ${name} ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  }, []);

  // Track the channel's active huddle from lifecycle events (B's discovery,
  // and A's "someone already started" guard) — same source HuddleIndicator
  // reads.
  React.useEffect(() => {
    if (!role || !joined) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    const ended = new Set<string>();
    relayClient
      .subscribeToHuddleEvents(channelId, (event: RelayEvent) => {
        if (disposed) return;
        let ephId: string | null = null;
        try {
          ephId = JSON.parse(event.content).ephemeral_channel_id ?? null;
        } catch {
          ephId = null;
        }
        if (!ephId) return;
        if (event.kind === KIND_HUDDLE_ENDED) {
          ended.add(ephId);
          setSeenHuddle((cur) => (cur === ephId ? null : cur));
        } else if (event.kind === KIND_HUDDLE_STARTED && !ended.has(ephId)) {
          setSeenHuddle(ephId);
        }
      })
      .then((dispose) => {
        if (disposed) void dispose();
        else cleanup = () => void dispose();
      })
      .catch((err) => console.error("[HuddleProbe] subscribe failed:", err));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [role, joined, channelId]);

  // Membership first, for both roles: huddle lifecycle events for a channel
  // only reliably reach members, so B must be in the channel before it can
  // ever see A's kind:48100.
  React.useEffect(() => {
    if (!role || joined) return;
    void (async () => {
      setStatus("joining-channel");
      await joinChannel(channelId).catch((err) => {
        // Already a member is fine — anything else surfaces downstream.
        console.warn("[HuddleProbe] joinChannel:", err);
      });
      setJoined(true);
      setStatus("channel-joined");
    })();
  }, [role, joined, channelId]);

  // Drive: start (A) or join (B) the huddle.
  React.useEffect(() => {
    if (!role || !joined || attempted.current) return;
    if (role === "B" && !seenHuddle) return;
    attempted.current = true;
    void (async () => {
      try {
        if (role === "A") {
          setStatus("starting-huddle");
          await startHuddle(channelId, []);
        } else {
          setStatus("joining-huddle");
          await joinHuddle(channelId, seenHuddle as string);
        }
        setStatus("in-huddle");
      } catch (err) {
        console.error("[HuddleProbe] drive failed:", err);
        setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`);
        attempted.current = false; // allow the next lifecycle event to retry
      }
    })();
  }, [role, joined, seenHuddle, channelId, startHuddle, joinHuddle]);

  // Mirror state where the harness can read it.
  React.useEffect(() => {
    const summary = {
      role,
      status,
      micConnected,
      activeEphemeralChannelId,
      activeSpeakers,
      huddleError,
      seenHuddle,
    };
    (window as unknown as Record<string, unknown>).__HUDDLE_PROBE__ = summary;
    console.log("[HuddleProbe]", JSON.stringify(summary));
  }, [
    role,
    status,
    micConnected,
    activeEphemeralChannelId,
    activeSpeakers,
    huddleError,
    seenHuddle,
  ]);

  // The native window title ignores document.title in Tauri, so the status
  // line lives in the DOM where a screenshot can read it.
  return (
    <div
      id="huddle-probe-status"
      style={{
        position: "fixed",
        top: 2,
        right: 2,
        zIndex: 99999,
        pointerEvents: "none",
        background: "#111",
        color: "#0f0",
        font: "12px monospace",
        padding: "2px 6px",
        whiteSpace: "pre",
      }}
    >
      {`PROBE ${role ?? "?"} ${status} mic=${micConnected ? 1 : 0} eph=${
        activeEphemeralChannelId?.slice(0, 8) ?? "-"
      } spk=${activeSpeakers.length}\n${diag}${huddleError ? `\nERR ${huddleError}` : ""}`}
    </div>
  );
}
