import * as React from "react";
import { Clock, Flame, Landmark, Wallet } from "lucide-react";

import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import { netSpendableBaseUnits } from "@/features/profile/lib/agentNetworkFlow";
import {
  formatBurnRatePerMinute,
  networkSpendRunwayCaption,
  type NetworkSpendState,
} from "@/features/profile/lib/networkSpendState";
import { parseUsdcAmount } from "@/features/payments/lib/paymentsOverview";
import type { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import {
  type ProfileField,
  ProfileFieldGroup,
} from "@/features/profile/ui/UserProfilePanelFields";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/**
 * Network spend block (#80) — USDC, prepaid, exact, enforcing. Sibling to
 * the Model usage block (buzz#75) in the Money tab, never summed with it:
 * different physics, different verbs, and a refill would not help the
 * other one (see `UserProfilePanelMoneyTab.tsx`'s module doc).
 *
 * Only the identity this desktop process itself pays as (`isSelf`) has a
 * channel to read — see `networkSpendState.ts`'s module doc for the
 * architectural reason a managed agent's own spend cannot be read
 * remotely yet.
 *
 * `network` is passed in rather than read via its own `useNetworkSpend`
 * call: `UserProfilePanelMoneyTab.tsx` fetches it once and shares it with
 * the Spend attribution block (buzz#78) below this one, so viewing the
 * Money tab never asks the connector for the same channel's claim state
 * twice.
 */
export function NetworkSpendSection({
  isSelf,
  network,
}: {
  isSelf: boolean;
  network: ReturnType<typeof useNetworkSpend>;
}) {
  return (
    <section
      className="space-y-2"
      data-testid="user-profile-money-network-spend"
    >
      <h3 className="px-1 text-sm font-semibold text-foreground">
        Network spend
      </h3>
      <NetworkSpendBody isSelf={isSelf} network={network} />
      <p className="px-1 text-xs text-muted-foreground">
        USDC, prepaid, and exact — this balance empties and stays empty until
        topped up. Any income this agent earns nets into the same balance;
        there's no separate earnings account.
      </p>
    </section>
  );
}

function NetworkSpendNotice({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-2xl bg-muted/20 px-4 py-3"
      data-testid={testId}
    >
      <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function NetworkSpendBody({
  isSelf,
  network,
}: {
  isSelf: boolean;
  network: ReturnType<typeof useNetworkSpend>;
}) {
  const state = network.state;

  switch (state.kind) {
    case "relay":
      return (
        <NetworkSpendNotice testId="user-profile-money-network-spend-relay">
          This community isn't using paid transport — nothing here costs money.
        </NetworkSpendNotice>
      );
    case "pending":
      return (
        <NetworkSpendNotice testId="user-profile-money-network-spend-pending">
          Checking network spend…
        </NetworkSpendNotice>
      );
    case "unavailable":
      return (
        <NetworkSpendNotice testId="user-profile-money-network-spend-unavailable">
          {isSelf
            ? "No payment channel is open yet — it opens automatically on the first paid write."
            : "This agent's network spend can't be read from this device yet — only your own wallet's channel is."}
        </NetworkSpendNotice>
      );
    case "quoted":
      return <NetworkSpendReady network={network} state={state} />;
  }
}

function buildNetworkSpendFields(
  state: Extract<NetworkSpendState, { kind: "quoted" }>,
): ProfileField[] {
  return [
    {
      displayValue: formatUsdcBaseUnits(netSpendableBaseUnits(state.read)),
      icon: Wallet,
      label: "Balance",
      testId: "user-profile-money-network-balance",
    },
    {
      displayValue: formatUsdcBaseUnits(state.read.depositBaseUnits),
      icon: Landmark,
      label: "Allowance",
      testId: "user-profile-money-network-allowance",
    },
    {
      displayValue: networkSpendRunwayCaption(state.read, state.hasBurnSample),
      icon: Clock,
      label: "Runway",
      testId: "user-profile-money-network-runway",
    },
    {
      displayValue: state.hasBurnSample
        ? formatBurnRatePerMinute(state.read.burnRateBaseUnitsPerSec)
        : "Not yet measured",
      icon: Flame,
      label: "Burn rate",
      testId: "user-profile-money-network-burn-rate",
    },
  ];
}

function NetworkSpendReady({
  network,
  state,
}: {
  network: ReturnType<typeof useNetworkSpend>;
  state: Extract<NetworkSpendState, { kind: "quoted" }>;
}) {
  const [depositInput, setDepositInput] = React.useState("");
  const fields = buildNetworkSpendFields(state);

  return (
    <div className="space-y-2">
      {network.depositError ? (
        <p
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="user-profile-money-network-deposit-error"
        >
          {network.depositError}
        </p>
      ) : null}

      <ProfileFieldGroup fields={fields} />

      {network.canDeposit ? (
        <div className="flex items-center gap-2 px-1 pt-1">
          <Input
            aria-label="Top up amount, in USDC"
            data-testid="user-profile-money-network-deposit-amount"
            inputMode="decimal"
            onChange={(event) => setDepositInput(event.target.value)}
            placeholder="Amount in USDC"
            value={depositInput}
          />
          <Button
            data-testid="user-profile-money-network-deposit-submit"
            disabled={
              network.depositPending || parseUsdcAmount(depositInput) === null
            }
            onClick={() => {
              const amount = parseUsdcAmount(depositInput);
              if (amount === null) return;
              void network.deposit(amount).then((succeeded) => {
                if (succeeded) setDepositInput("");
              });
            }}
            size="sm"
            type="button"
          >
            {network.depositPending ? "Topping up…" : "Top up"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
