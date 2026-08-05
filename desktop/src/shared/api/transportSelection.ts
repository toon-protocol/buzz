import { getStoredMnemonic } from "@/features/onboarding/toon/toonOnboardingStore";
import { recordNetworkSpendWrite } from "@/features/profile/lib/networkSpendLiveStore";
import { setEventTransport } from "@/shared/api/eventTransport";
import { resetMediaUploader, setMediaUploader } from "@/shared/api/mediaUpload";
import { StoreMediaUploader } from "@/shared/api/storeMediaUploader";
import { getTransportEnv } from "@/shared/api/tauriTransport";
import { ToonEventTransport } from "@/shared/api/toonEventTransport";
import {
  ToonPaidWriter,
  type PaidClientFactory,
} from "@/shared/api/toonPaidWriter";
import {
  ToonRelayReader,
  type ToonSocketFactory,
} from "@/shared/api/toonRelayReader";
import { setArweaveGateways } from "@/shared/lib/arweaveMedia";
import {
  decideTransport,
  type ToonTransportEnv,
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
 * `BUZZ_TOON_MNEMONIC` layered with the onboarding wizard's stored identity.
 *
 * The environment wins, same precedence `channelKeyStore`'s `BUZZ_CHANNEL_KEYS`
 * uses and for the same reason: it is set by whoever launched the process,
 * which makes it the more recent instruction, and a scripted or two-box setup
 * that cannot override a wizard-generated identity cannot be relied on to test
 * anything. Without it, a fresh install has no mnemonic at bootstrap — that is
 * exactly the case the wizard exists for, and once it generates one this
 * merge is what lets the *next* launch pick it up without the env var ever
 * being set.
 */
function withWizardMnemonic(env: Record<string, string>): ToonTransportEnv {
  if (env.BUZZ_TOON_MNEMONIC?.trim()) return env;
  const stored = getStoredMnemonic();
  return stored ? { ...env, BUZZ_TOON_MNEMONIC: stored } : env;
}

/**
 * A test-only escape hatch (buzz#131) letting the e2e bridge run the TOON
 * transport against a fake payment client and a fake relay socket instead of
 * the real devnet. `testing/e2eBridgeToon.ts` installs this global before
 * `installSelectedTransport` runs (see `main.tsx`'s bootstrap order); every
 * real build leaves it undefined, so the branch below is a no-op there.
 */
export type ToonE2eTestOverrides = {
  paidClientFactory: PaidClientFactory;
  socketFactory: ToonSocketFactory;
};

function getToonE2eTestOverrides(): ToonE2eTestOverrides | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window as unknown as {
      __BUZZ_E2E_TOON_TEST_OVERRIDES__?: ToonE2eTestOverrides;
    }
  ).__BUZZ_E2E_TOON_TEST_OVERRIDES__;
}

/** The transport this run installed, so a later caller (the onboarding wizard) can reach it without a second resolve. */
let activeToonTransport: ToonEventTransport | null = null;
let activeSelection: TransportSelection | null = null;

/** The active TOON transport instance, or null when this run is not on TOON. */
export function getActiveToonTransport(): ToonEventTransport | null {
  return activeToonTransport;
}

/** The transport mode and resolved config this run installed. */
export function getActiveTransportSelection(): TransportSelection | null {
  return activeSelection;
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

  const selection = decideTransport(withWizardMnemonic(env), viteOverride());
  for (const warning of selection.warnings) {
    console.warn(`[transport] ${warning}`);
  }
  activeSelection = selection;

  if (selection.mode !== "toon") {
    activeToonTransport = null;
    // Blossom on the community relay stays the media backend in relay mode —
    // the transport switch governs media too, so a run that writes events to
    // the relay never writes attachments to the permaweb.
    resetMediaUploader();
    return selection;
  }

  try {
    const overrides = getToonE2eTestOverrides();
    const transport = new ToonEventTransport(
      selection.config,
      overrides
        ? {
            writer: new ToonPaidWriter(
              selection.config,
              overrides.paidClientFactory,
            ),
            reader: new ToonRelayReader(
              selection.config.relayUrl,
              overrides.socketFactory,
            ),
          }
        : undefined,
    );
    setEventTransport(transport);
    setArweaveGateways(selection.config.arweaveGateways);
    setMediaUploader(new StoreMediaUploader(transport.getPaidWriter()));
    // Feeds the Money tab's Network spend burn rate (#80) — module-level
    // store + useSyncExternalStore per the epic's established idiom.
    transport.onPaidWrite(recordNetworkSpendWrite);
    activeToonTransport = transport;
    console.info(
      `[transport] TOON active — paying ${selection.config.destination} via ${
        selection.config.btpUrl ?? selection.config.proxyUrl
      }, reading ${selection.config.relayUrl}, storing media at ${selection.config.storeDestination}`,
    );
  } catch (error) {
    console.error(
      "[transport] TOON transport failed to install; staying on the relay",
      error,
    );
    activeToonTransport = null;
    resetMediaUploader();
    activeSelection = { ...selection, mode: "relay" };
    return activeSelection;
  }

  return selection;
}
