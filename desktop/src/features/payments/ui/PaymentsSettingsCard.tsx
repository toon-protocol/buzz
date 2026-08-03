import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import {
  canCloseChannel,
  canDepositToChannel,
  canSettleChannel,
  channelRunwayCaption,
  parseUsdcAmount,
  type PaymentsCardState,
} from "@/features/payments/lib/paymentsOverview";
import { usePaymentsOverview } from "@/features/payments/lib/usePaymentsOverview";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  SettingsOptionGroup,
  SettingsOptionRow,
} from "@/features/settings/ui/SettingsOptionGroup";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";

/**
 * Settings -> Payments (buzz#77): the owner's own wallet and treasury.
 *
 * The one re-entry point into payment management once the onboarding wizard
 * has closed for good — before this card there was nowhere to see a
 * balance, top up, or reclaim collateral after the first message shipped.
 * Follows the `SettingsOptionGroup`/`SettingsOptionRow` idiom every other
 * Settings card uses; money formatting reuses `formatUsdcBaseUnits`, the
 * same helper the onboarding wizard and the huddle/composer fee captions use.
 */
export function PaymentsSettingsCard() {
  const overview = usePaymentsOverview();
  const state = overview.state;

  return (
    <section className="min-w-0" data-testid="settings-payments">
      <SettingsSectionHeader
        title="Payments"
        description="Your wallet, payment channel, and agent fleet spend."
      />

      {state.kind === "relay" ? (
        <PaymentsNotice testId="payments-relay-notice">
          This community isn't using paid transport — nothing here costs money.
        </PaymentsNotice>
      ) : null}

      {state.kind === "no-wallet" ? (
        <PaymentsNotice testId="payments-no-wallet">
          Payment setup hasn't completed yet — finish the payment wizard to open
          a wallet.
        </PaymentsNotice>
      ) : null}

      {state.kind === "loading" ? (
        <PaymentsNotice testId="payments-loading">
          Checking your wallet…
        </PaymentsNotice>
      ) : null}

      {state.kind === "ready" ? (
        <ReadyPaymentsCard overview={overview} state={state} />
      ) : null}
    </section>
  );
}

/** The shared style for the card's single-line status notices. */
function PaymentsNotice({
  testId,
  children,
}: {
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className="rounded-lg bg-muted/30 px-3 py-2 text-sm font-normal text-muted-foreground"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

type ReadyOverview = Omit<ReturnType<typeof usePaymentsOverview>, "state">;

/**
 * The card body once a wallet and its first reads exist. Split out from
 * {@link PaymentsSettingsCard} so `state` narrows to the `"ready"` variant
 * for the whole component — TS cannot retain that narrowing across a parent
 * whose `state` field can still widen back out between renders.
 */
function ReadyPaymentsCard({
  overview,
  state,
}: {
  overview: ReadyOverview;
  state: Extract<PaymentsCardState, { kind: "ready" }>;
}) {
  const navigate = useNavigate();
  const [depositInput, setDepositInput] = React.useState("");

  return (
    <div className="flex flex-col gap-6">
      {overview.actionError ? (
        <p
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="payments-action-error"
        >
          {overview.actionError}
        </p>
      ) : null}

      <SettingsOptionGroup>
        <SettingsOptionRow>
          <div className="min-w-0">
            <p className="text-sm font-medium">Wallet address</p>
            <p
              className="break-all font-mono text-2xs text-muted-foreground"
              data-testid="payments-address"
            >
              {state.address}
            </p>
          </div>
          <Button
            onClick={() => copyTextToClipboard(state.address, "Address copied")}
            size="sm"
            type="button"
            variant="outline"
          >
            Copy
          </Button>
        </SettingsOptionRow>
        <SettingsOptionRow>
          <p className="text-sm font-medium">Balance</p>
          <p className="text-sm" data-testid="payments-balance">
            {state.balances.checked && state.balances.tokenBaseUnits !== null
              ? formatUsdcBaseUnits(state.balances.tokenBaseUnits)
              : "—"}
          </p>
        </SettingsOptionRow>
        <SettingsOptionRow>
          <p className="text-sm font-medium">Native gas</p>
          <p className="text-sm" data-testid="payments-native-gas">
            {state.balances.checked &&
            state.balances.nativeBaseUnits !== null &&
            state.balances.nativeBaseUnits > 0n
              ? "Funded"
              : "None"}
          </p>
        </SettingsOptionRow>
      </SettingsOptionGroup>

      <SettingsOptionGroup>
        <SettingsOptionRow>
          <div className="min-w-0">
            <p className="text-sm font-medium">Payment channel</p>
            <p
              className="text-sm font-normal text-muted-foreground"
              data-testid="payments-channel-runway"
            >
              {channelRunwayCaption(state.channel)}
            </p>
          </div>
          <Button
            disabled={overview.refreshing}
            onClick={() => void overview.refresh()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {overview.refreshing ? "Checking…" : "Refresh"}
          </Button>
        </SettingsOptionRow>

        {canDepositToChannel(state.channel) ? (
          <div className="flex items-center gap-2 px-4 pb-4 pt-1">
            <Input
              aria-label="Deposit amount, in USDC"
              data-testid="payments-deposit-amount"
              inputMode="decimal"
              onChange={(event) => setDepositInput(event.target.value)}
              placeholder="Amount in USDC"
              value={depositInput}
            />
            <Button
              data-testid="payments-deposit-submit"
              disabled={
                overview.actionPending || parseUsdcAmount(depositInput) === null
              }
              onClick={() => {
                const amount = parseUsdcAmount(depositInput);
                if (amount === null) return;
                void overview.deposit(amount).then((succeeded) => {
                  if (succeeded) setDepositInput("");
                });
              }}
              size="sm"
              type="button"
            >
              {overview.actionPending ? "Depositing…" : "Deposit"}
            </Button>
          </div>
        ) : null}

        {canCloseChannel(state.channel) || canSettleChannel(state.channel) ? (
          <div className="flex justify-end gap-2 px-4 pb-4">
            {canCloseChannel(state.channel) ? (
              <Button
                data-testid="payments-close-channel"
                disabled={overview.actionPending}
                onClick={() => void overview.closeChannel()}
                size="sm"
                type="button"
                variant="outline"
              >
                Close channel
              </Button>
            ) : null}
            {canSettleChannel(state.channel) ? (
              <Button
                data-testid="payments-settle-channel"
                disabled={overview.actionPending}
                onClick={() => void overview.settleChannel()}
                size="sm"
                type="button"
              >
                Settle and reclaim
              </Button>
            ) : null}
          </div>
        ) : null}
      </SettingsOptionGroup>

      <button
        className="flex items-center justify-between gap-4 rounded-2xl bg-muted/20 px-4 py-3 text-left text-sm hover:bg-muted/30"
        data-testid="payments-fleet-summary"
        onClick={() => void navigate({ to: "/agents" })}
        type="button"
      >
        <span className="text-muted-foreground">
          0 agents · 0.00 USDC allocated · 0.00 USDC remaining
        </span>
        <span className="flex shrink-0 items-center gap-1 font-medium">
          View agents
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </button>
    </div>
  );
}
