import * as React from "react";
import { toast } from "sonner";

import { useChannelsQuery } from "@/features/channels/hooks";
import {
  DEFAULT_CHANNEL_COLLATERAL_BASE_UNITS,
  formatUsdcBaseUnits,
} from "@/features/onboarding/toon/toonOnboardingFormat";
import { useToonOnboarding } from "@/features/onboarding/toon/useToonOnboarding";
import { STARTER_GENERAL_CHANNEL_NAME } from "@/features/onboarding/welcome";
import type { Channel } from "@/shared/api/types";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { BuzzMark } from "@/shared/ui/buzz-logo/BuzzMark";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { StepProgress } from "@/shared/ui/step-progress";
import { Textarea } from "@/shared/ui/textarea";

/**
 * The self-serve path a fresh TOON install takes before its first paid
 * message: identity → funded → payment channel → first message. Mounted
 * as a full-screen overlay atop the already-running app (the same shape as
 * `PendingInviteGate`) rather than in place of it, so the community/channel
 * connection this screen's last step needs is already live underneath.
 *
 * Renders nothing once the wizard's own state says it is done — see
 * `toonOnboardingState.ts` for how "done" is derived, and `useToonOnboarding`
 * for where that derivation gets its inputs.
 */
export function ToonOnboardingGate() {
  const onboarding = useToonOnboarding();
  const [justCreatedMnemonic, setJustCreatedMnemonic] = React.useState<
    string | null
  >(null);
  const [backupAcknowledged, setBackupAcknowledged] = React.useState(false);

  if (!onboarding.active || onboarding.status.step === "done") return null;

  // The freshly generated phrase is shown once, right after creation, and
  // blocks advancing past it regardless of what the derived step says —
  // the mnemonic is already stored by this point (so re-entrancy is intact
  // even if the user closes the app here), but a secret that is about to be
  // the ONLY copy outside this device deserves a deliberate "I saved it"
  // rather than an auto-advance the instant the store updates.
  const showBackupScreen = justCreatedMnemonic !== null && !backupAcknowledged;

  return (
    <div
      className="buzz-onboarding-neutral-theme buzz-startup-shell fixed inset-0 z-50 flex items-center justify-center bg-background px-4 py-8 text-foreground"
      data-testid="toon-onboarding-gate"
    >
      <StartupWindowDragRegion />
      <div className="flex w-full max-w-[440px] flex-col items-center">
        <BuzzMark className="h-auto w-10" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">
          Set up payments
        </h1>
        <StepProgress
          className="mt-3"
          currentStep={showBackupScreen ? 1 : stepIndex(onboarding.status.step)}
          totalSteps={4}
        />
        <div className="mt-6 w-full">
          {showBackupScreen ? (
            <BackupPhraseStep
              mnemonic={justCreatedMnemonic}
              onAcknowledge={() => {
                setBackupAcknowledged(true);
                setJustCreatedMnemonic(null);
              }}
            />
          ) : onboarding.status.step === "identity" ? (
            <IdentityStep
              onCreate={async () => {
                const generated = await onboarding.createIdentity();
                setJustCreatedMnemonic(generated);
                setBackupAcknowledged(false);
              }}
              onImport={onboarding.importIdentity}
            />
          ) : onboarding.status.step === "fund" ? (
            <FundStep onboarding={onboarding} />
          ) : onboarding.status.step === "channel" ? (
            <ChannelStep onboarding={onboarding} />
          ) : (
            <MessageStep onboarding={onboarding} />
          )}
        </div>
      </div>
    </div>
  );
}

function stepIndex(step: "identity" | "fund" | "channel" | "message" | "done") {
  switch (step) {
    case "identity":
      return 1;
    case "fund":
      return 2;
    case "channel":
      return 3;
    default:
      return 4;
  }
}

function StepCopy({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-center text-sm leading-6 text-muted-foreground">
      {children}
    </p>
  );
}

function IdentityStep({
  onCreate,
  onImport,
}: {
  onCreate: () => Promise<void>;
  onImport: (phrase: string) => Promise<void>;
}) {
  const [creating, setCreating] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);
  const [importDraft, setImportDraft] = React.useState("");
  const [importError, setImportError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      <StepCopy>
        Paying to write on TOON needs a wallet. Buzz can generate one for you
        now — it's separate from your Buzz identity and only pays for TOON
        writes.
      </StepCopy>
      {showImport ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Recovery phrase"
            className="font-mono text-xs"
            data-testid="toon-onboarding-import-input"
            onChange={(event) => {
              setImportDraft(event.target.value);
              setImportError(null);
            }}
            placeholder="12 or 24 word recovery phrase"
            value={importDraft}
          />
          {importError ? (
            <p className="text-xs text-destructive">{importError}</p>
          ) : null}
          <Button
            data-testid="toon-onboarding-import-save"
            disabled={importing || importDraft.trim().length === 0}
            onClick={async () => {
              setImporting(true);
              try {
                await onImport(importDraft);
              } catch (error) {
                setImportError(
                  error instanceof Error ? error.message : String(error),
                );
              } finally {
                setImporting(false);
              }
            }}
            type="button"
          >
            {importing ? "Checking…" : "Use this phrase"}
          </Button>
        </div>
      ) : (
        <>
          <Button
            data-testid="toon-onboarding-create"
            disabled={creating}
            onClick={async () => {
              setCreating(true);
              try {
                await onCreate();
              } finally {
                setCreating(false);
              }
            }}
            type="button"
          >
            {creating ? "Generating…" : "Create a wallet"}
          </Button>
          <Button
            data-testid="toon-onboarding-show-import"
            onClick={() => setShowImport(true)}
            type="button"
            variant="ghost"
          >
            I already have a recovery phrase
          </Button>
        </>
      )}
    </div>
  );
}

function BackupPhraseStep({
  mnemonic,
  onAcknowledge,
}: {
  mnemonic: string;
  onAcknowledge: () => void;
}) {
  const [confirmed, setConfirmed] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      <StepCopy>
        Write this phrase down. It's the only way to recover this wallet — no
        one, including Buzz, can recover it for you.
      </StepCopy>
      <div
        className="break-all rounded-lg bg-muted px-3 py-3 text-center font-mono text-sm text-foreground"
        data-testid="toon-onboarding-mnemonic"
      >
        {mnemonic}
      </div>
      <Button
        onClick={() => copyTextToClipboard(mnemonic, "Recovery phrase copied")}
        type="button"
        variant="outline"
      >
        Copy phrase
      </Button>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          type="checkbox"
        />
        I've saved this phrase somewhere safe
      </label>
      <Button
        data-testid="toon-onboarding-backup-continue"
        disabled={!confirmed}
        onClick={onAcknowledge}
        type="button"
      >
        Continue
      </Button>
    </div>
  );
}

function FundStep({
  onboarding,
}: {
  onboarding: ReturnType<typeof useToonOnboarding>;
}) {
  const { status, balances, faucetOutcome, faucetLoading } = onboarding;
  const retrySeconds =
    faucetOutcome?.status === "cooldown"
      ? faucetOutcome.retryAfterSeconds
      : null;
  const countdown = useCountdown(retrySeconds);

  return (
    <div className="flex flex-col gap-4">
      <StepCopy>
        This wallet needs devnet USDC to pay for writes, and a little native gas
        to open its payment channel. Requesting funds drips both.
      </StepCopy>
      {onboarding.address ? (
        <div className="flex flex-col gap-2">
          <div
            className="break-all rounded-lg bg-muted px-3 py-2 text-center font-mono text-xs text-foreground"
            data-testid="toon-onboarding-address"
          >
            {onboarding.address}
          </div>
          <Button
            onClick={() =>
              copyTextToClipboard(onboarding.address ?? "", "Address copied")
            }
            type="button"
            variant="outline"
          >
            Copy address
          </Button>
        </div>
      ) : null}

      <div
        className="flex items-center justify-between rounded-lg border border-input/40 px-3 py-2 text-xs"
        data-testid="toon-onboarding-balances"
      >
        <span className="text-muted-foreground">USDC</span>
        <span>
          {balances.checked && balances.tokenBaseUnits !== null
            ? formatUsdcBaseUnits(balances.tokenBaseUnits)
            : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-input/40 px-3 py-2 text-xs">
        <span className="text-muted-foreground">Native gas</span>
        <span>{status.hasNativeGas ? "funded" : "none yet"}</span>
      </div>

      {status.needsManualGasTopUp ? (
        <Alert variant="default">
          <AlertDescription>
            USDC arrived, but the faucet's gas top-up didn't land this time —
            that leg is best-effort. Send a small amount of Base Sepolia ETH to
            the address above, then check again. A public Base Sepolia faucet
            works too.
          </AlertDescription>
        </Alert>
      ) : null}

      {faucetOutcome?.status === "cooldown" ? (
        <Alert variant="default">
          <AlertDescription>
            {countdown !== null
              ? `Already requested recently — try again in ${countdown}s.`
              : faucetOutcome.message}
          </AlertDescription>
        </Alert>
      ) : null}
      {faucetOutcome?.status === "error" ? (
        <Alert variant="destructive">
          <AlertDescription>{faucetOutcome.message}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        data-testid="toon-onboarding-request-funds"
        disabled={faucetLoading || !onboarding.address}
        onClick={() => void onboarding.requestFunds()}
        type="button"
      >
        {faucetLoading ? "Requesting…" : "Get devnet funds"}
      </Button>
      <Button
        disabled={onboarding.balancesLoading}
        onClick={() => void onboarding.refreshBalances()}
        type="button"
        variant="ghost"
      >
        {onboarding.balancesLoading ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}

function ChannelStep({
  onboarding,
}: {
  onboarding: ReturnType<typeof useToonOnboarding>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StepCopy>
        Paying for writes goes through a payment channel. Opening one locks up
        to{" "}
        <strong className="text-foreground">
          {formatUsdcBaseUnits(DEFAULT_CHANNEL_COLLATERAL_BASE_UNITS)}
        </strong>{" "}
        as collateral — released when you close the channel. This is an on-chain
        transaction.
      </StepCopy>
      {onboarding.channelError ? (
        <Alert variant="destructive">
          <AlertDescription>{onboarding.channelError}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        data-testid="toon-onboarding-open-channel"
        disabled={onboarding.channelLoading}
        onClick={() => void onboarding.openChannel()}
        type="button"
      >
        {onboarding.channelLoading ? "Opening…" : "Open payment channel"}
      </Button>
    </div>
  );
}

function findDefaultPublicChannel(channels: Channel[]): Channel | null {
  const open = channels.filter(
    (channel) =>
      channel.channelType !== "dm" &&
      channel.visibility === "open" &&
      channel.archivedAt === null,
  );
  const general = open.find(
    (channel) =>
      channel.name.trim().toLowerCase() === STARTER_GENERAL_CHANNEL_NAME,
  );
  return general ?? open[0] ?? null;
}

function MessageStep({
  onboarding,
}: {
  onboarding: ReturnType<typeof useToonOnboarding>;
}) {
  const { data: channels } = useChannelsQuery();
  const targetChannel = React.useMemo(
    () => findDefaultPublicChannel(channels ?? []),
    [channels],
  );
  const [content, setContent] = React.useState("");
  const { quoteMessageFee, messageFee, feeError } = onboarding;

  // biome-ignore lint/correctness/useExhaustiveDependencies: quote once on mount — re-quoting on every render would re-ask the connector for no reason.
  React.useEffect(() => {
    void quoteMessageFee();
  }, []);

  const canSend =
    messageFee !== null && content.trim().length > 0 && targetChannel !== null;

  return (
    <div className="flex flex-col gap-4">
      <StepCopy>
        {targetChannel
          ? `Send your first message in #${targetChannel.name}.`
          : "No public channel is available yet."}
      </StepCopy>

      {feeError ? (
        <Alert variant="destructive">
          <AlertDescription>{feeError}</AlertDescription>
        </Alert>
      ) : (
        <div
          className="flex items-center justify-between rounded-lg border border-input/40 px-3 py-2 text-xs"
          data-testid="toon-onboarding-fee"
        >
          <span className="text-muted-foreground">This message costs</span>
          <span>
            {messageFee !== null ? formatUsdcBaseUnits(messageFee) : "quoting…"}
          </span>
        </div>
      )}

      <Textarea
        data-testid="toon-onboarding-message-input"
        onChange={(event) => setContent(event.target.value)}
        placeholder="Say hello"
        value={content}
      />
      {onboarding.sendError ? (
        <Alert variant="destructive">
          <AlertDescription>{onboarding.sendError}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        className={cn(canSend && "")}
        data-testid="toon-onboarding-send"
        disabled={!canSend || onboarding.sendLoading}
        onClick={async () => {
          if (!targetChannel) return;
          try {
            await onboarding.sendFirstMessage(targetChannel.id, content);
            toast.success("Sent — you're all set.");
          } catch {
            // Surfaced inline via onboarding.sendError; nothing else to do.
          }
        }}
        type="button"
      >
        {onboarding.sendLoading
          ? "Sending…"
          : messageFee !== null
            ? `Send for ${formatUsdcBaseUnits(messageFee)}`
            : "Send"}
      </Button>
    </div>
  );
}

/** Ticks a cooldown countdown down to zero once a second, then stops. */
function useCountdown(seconds: number | null): number | null {
  const [remaining, setRemaining] = React.useState(seconds);

  React.useEffect(() => {
    setRemaining(seconds);
    if (seconds === null) return;
    const interval = setInterval(() => {
      setRemaining((prev) => (prev === null || prev <= 1 ? null : prev - 1));
    }, 1_000);
    return () => clearInterval(interval);
  }, [seconds]);

  return remaining;
}
