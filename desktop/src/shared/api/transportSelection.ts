import { setEventTransport } from "@/shared/api/eventTransport";
import { getTransportEnv } from "@/shared/api/tauriTransport";
import { ToonEventTransport } from "@/shared/api/toonEventTransport";
import {
  decideTransport,
  type TransportSelection,
} from "@/shared/api/toonTransportConfig";

/**
 * Which transport this run of the app writes and reads through.
 *
 * The relay transport is the default and stays the default. Buzz tracks
 * `block/buzz` upstream, and a hard swap would make every cherry-pick a
 * conflict; the TOON transport is therefore installed by an explicit opt-in
 * (`BUZZ_TRANSPORT=toon`) that the vendor's own builds never set.
 *
 * The value is read at runtime from the Rust side, not from `import.meta.env`,
 * for the same reason `BUZZ_RELAY_URL` is: a build-time constant cannot be
 * flipped on an installed app, and pointing a shipped build at a devnet is
 * exactly what this switch is for. `VITE_BUZZ_TRANSPORT` is honoured first as
 * a synchronous dev override for `pnpm dev` and Playwright.
 *
 * The decision itself lives in `toonTransportConfig.decideTransport`; this
 * module is the imperative shell that reads the environment and mutates the
 * registry.
 */

/** Vite exposes only `VITE_`-prefixed keys, so the dev override is renamed. */
function viteOverride(): string | null {
  const value = import.meta.env.VITE_BUZZ_TRANSPORT;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Install the selected transport. Called once, before the app renders, so no
 * write or subscription can be issued against a transport that is about to be
 * replaced.
 *
 * Never throws: a transport that cannot be built is a reason to run on the
 * relay, not a reason to fail to start.
 */
export async function installSelectedTransport(): Promise<TransportSelection> {
  let env: Record<string, string> = {};
  try {
    env = await getTransportEnv();
  } catch (error) {
    console.warn(
      "[transport] could not read transport config from Tauri",
      error,
    );
  }

  const selection = decideTransport(env, viteOverride());
  for (const warning of selection.warnings) {
    console.warn(`[transport] ${warning}`);
  }

  if (selection.mode !== "toon") return selection;

  try {
    setEventTransport(new ToonEventTransport(selection.config));
    console.info(
      `[transport] TOON active — paying ${selection.config.destination} via ${selection.config.proxyUrl}, reading ${selection.config.relayUrl}`,
    );
  } catch (error) {
    console.error(
      "[transport] TOON transport failed to install; staying on the relay",
      error,
    );
    return { ...selection, mode: "relay" };
  }

  return selection;
}
