import React from "react";
import ReactDOM from "react-dom/client";
import "@/shared/api/bufferPolyfill";
import { App } from "@/app/App";
import { NostrBindConsentDialog } from "@/features/profile/ui/NostrBindConsentDialog";
import "@fontsource-variable/inter/wght.css";
import "@/shared/styles/globals.css";
import { UpdaterProvider } from "@/features/settings/hooks/UpdaterProvider";
import { migrateLegacyCommunityStorageBeforeRender } from "@/features/communities/legacyCommunityStorage";
import { CommunitiesProvider } from "@/features/communities/useCommunities";
import { CommunityOnboardingProvider } from "@/features/onboarding/communityOnboarding";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { EmojiBurstProvider } from "@/shared/ui/EmojiBurstProvider";
import { PoofBurstProvider } from "@/shared/ui/PoofBurstProvider";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { recoverLocalStorageQuotaOnStartup } from "@/shared/lib/localStorageQuota";
import { installSelectedTransport } from "@/shared/api/transportSelection";
import { installRustWriteBridge } from "@/shared/api/rustWriteBridge";
import {
  installChannelKeyInbox,
  loadChannelKeysFromEnvironment,
} from "@/shared/api/channelKeyBootstrap";
import { installChannelKeyEpochSync } from "@/shared/api/channelKeyEpoch";
import { installChannelKeySync } from "@/shared/api/channelKeySync";

type E2eWindow = Window & {
  __BUZZ_E2E__?: unknown;
};

const E2E_DEFAULT_PUBKEY = "deadbeef".repeat(8);
const E2E_COMMUNITY_ID = "e2e-default-community";
const ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX = "buzz-onboarding-complete.v1:";
const DEV_STATE_RESET_PARAM = "resetDevState";

function resetDevWebviewStateFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get(DEV_STATE_RESET_PARAM) !== "1") {
    return;
  }

  // WebKit groups every Buzz binary under one disk directory, but storage is
  // isolated by origin. Clearing here resets only this dev server's origin;
  // deleting the shared WebKit directory would also destroy installed-app state.
  window.localStorage.clear();
  window.sessionStorage.clear();
  url.searchParams.delete(DEV_STATE_RESET_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

function configureDevE2eBridgeFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get("e2e") !== "mock") {
    return;
  }

  const e2eWindow = window as E2eWindow;
  e2eWindow.__BUZZ_E2E__ ??= { mode: "mock" };

  const community = {
    addedAt: new Date().toISOString(),
    id: E2E_COMMUNITY_ID,
    name: "E2E Test",
    relayUrl: "ws://localhost:3000",
  };
  window.localStorage.setItem("buzz-communities", JSON.stringify([community]));
  window.localStorage.setItem("buzz-active-community-id", E2E_COMMUNITY_ID);
  window.localStorage.setItem(
    `${ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX}${E2E_DEFAULT_PUBKEY}`,
    "true",
  );
}

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <CommunitiesProvider>
        <CommunityOnboardingProvider>
          <ThemeProvider defaultTheme="buzz">
            <TooltipProvider delayDuration={300}>
              <EmojiBurstProvider>
                <PoofBurstProvider>
                  <UpdaterProvider>
                    <App />
                    <NostrBindConsentDialog />
                  </UpdaterProvider>
                  <Toaster />
                </PoofBurstProvider>
              </EmojiBurstProvider>
            </TooltipProvider>
          </ThemeProvider>
        </CommunityOnboardingProvider>
      </CommunitiesProvider>
    </React.StrictMode>,
  );
}

async function installE2eBridgeIfConfigured() {
  // The mock bridge is compiled only into dev and explicit E2E builds. A
  // pre-bootstrap global alone must never activate mock IPC in production.
  if (
    !(import.meta.env.DEV || import.meta.env.MODE === "e2e") ||
    !(window as E2eWindow).__BUZZ_E2E__
  ) {
    return;
  }

  const { maybeInstallE2eTauriMocks } = await import("@/testing/e2eBridge");
  maybeInstallE2eTauriMocks();
}

async function bootstrap() {
  resetDevWebviewStateFromUrl();
  configureDevE2eBridgeFromUrl();
  recoverLocalStorageQuotaOnStartup();
  await installE2eBridgeIfConfigured();
  // Before render, so no write or subscription can be issued against a
  // transport that is about to be replaced.
  await installSelectedTransport();
  // After the transport is chosen, so a Rust-side write bridged over
  // (buzz#27) publishes through whichever one this run selected.
  await installRustWriteBridge();
  // Also before render: an event that arrives before its key is loaded renders
  // as locked and never re-decrypts.
  await loadChannelKeysFromEnvironment();
  // After the store is seeded, so the first sync already carries any
  // BUZZ_CHANNEL_KEYS-provided keys and Rust-built writes can seal from the
  // very first message (buzz#33).
  installChannelKeySync();
  // Before the inbox opens, so the first admin list to arrive can already
  // promote a rotation key this client was sent in an earlier session
  // (buzz#18). Local and synchronous — it reads two in-memory stores.
  installChannelKeyEpochSync();
  await migrateLegacyCommunityStorageBeforeRender();
  renderApp();
  // After render, and deliberately not awaited: the gift-wrap inbox opens relay
  // subscriptions, and a relay that is slow or unreachable must delay a channel
  // unlocking, not the window opening. Unlike the environment seed above, a key
  // that arrives late is fine — `setChannelKey` notifies its listeners. Never
  // throws; see `installChannelKeyInbox`.
  void installChannelKeyInbox();
}

void bootstrap();
