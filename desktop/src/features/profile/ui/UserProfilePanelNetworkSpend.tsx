import * as React from "react";
import { Clock, Flame, Landmark, RefreshCw, Wallet } from "lucide-react";

import { deriveSuggestedCeilingBaseUnits } from "@/features/agents/lib/agentAutoRefillPolicy";
import {
  getAgentAutoRefillVersion,
  getAutoRefillConfig,
  getMonthlyRefillSpendBaseUnits,
  setAutoRefillConfig,
  subscribeToAgentAutoRefillState,
} from "@/features/agents/lib/agentAutoRefillStore";
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
import { Switch } from "@/shared/ui/switch";

/**
 * Network spend block (#80) — USDC, prepaid, exact, enforcing. Sibling to
 * the Model usage block (buzz#75) in the Money tab, never summed with it:
 * different physics, different verbs, and a refill would not help the
 * other one (see `UserProfilePanelMoneyTab.tsx`'s module doc).
 *
 * Every managed agent has a channel to read (buzz#109 / `docs/adr/0007`),
 * not only the identity this desktop process itself pays as (`isSelf`) —
 * see `useNetworkSpend.ts`'s module doc for the two read paths. `isSelf`
 * still matters here for copy (the two `unavailable` reasons read
 * differently) and for gating the refill action, which only ever touches
 * this process's own writer.
 *
 * `network` is passed in rather than read via its own `useNetworkSpend`
 * call: `UserProfilePanelMoneyTab.tsx` fetches it once and shares it with
 * the Spend attribution block (buzz#78) below this one, so viewing the
 * Money tab never asks the connector for the same channel's claim state
 * twice.
 */
export function NetworkSpendSection({
  agentPubkey,
  isSelf,
  network,
}: {
  agentPubkey: string;
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
      <NetworkSpendBody
        agentPubkey={agentPubkey}
        isSelf={isSelf}
        network={network}
      />
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
  agentPubkey,
  isSelf,
  network,
}: {
  agentPubkey: string;
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
            : "No payment channel could be found for this agent yet."}
        </NetworkSpendNotice>
      );
    case "quoted":
      return (
        <NetworkSpendReady
          agentPubkey={agentPubkey}
          isSelf={isSelf}
          network={network}
          state={state}
        />
      );
  }
}

function buildNetworkSpendFields(
  state: Extract<NetworkSpendState, { kind: "quoted" }>,
  autoRefill: {
    config: ReturnType<typeof getAutoRefillConfig>;
    spentBaseUnits: bigint;
  },
): ProfileField[] {
  const fields: ProfileField[] = [
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

  if (autoRefill.config.enabled) {
    fields.push({
      displayValue: `${formatUsdcBaseUnits(autoRefill.spentBaseUnits)} / ${formatUsdcBaseUnits(autoRefill.config.ceilingBaseUnits)} this month`,
      icon: RefreshCw,
      label: "Auto-refill",
      testId: "user-profile-money-network-auto-refill-spend",
    });
  }

  return fields;
}

function NetworkSpendReady({
  agentPubkey,
  isSelf,
  network,
  state,
}: {
  agentPubkey: string;
  isSelf: boolean;
  network: ReturnType<typeof useNetworkSpend>;
  state: Extract<NetworkSpendState, { kind: "quoted" }>;
}) {
  const [depositInput, setDepositInput] = React.useState("");
  const autoRefillVersion = React.useSyncExternalStore(
    subscribeToAgentAutoRefillState,
    getAgentAutoRefillVersion,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoRefillVersion is a useSyncExternalStore snapshot that forces this memo to re-read the mutable agentAutoRefillStore.ts config/ledger
  const autoRefill = React.useMemo(
    () => ({
      config: getAutoRefillConfig(agentPubkey),
      spentBaseUnits: getMonthlyRefillSpendBaseUnits(agentPubkey),
    }),
    [agentPubkey, autoRefillVersion],
  );
  const fields = buildNetworkSpendFields(state, autoRefill);

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

      {/* Refill deposits only ever land on this process's own writer
       * (useNetworkSpend.ts's documented isSelf constraint), same as manual
       * top-up above — auto-refill is offered under the same gate. */}
      {isSelf && network.canDeposit ? (
        <AutoRefillControl
          agentPubkey={agentPubkey}
          config={autoRefill.config}
          hasBurnSample={state.hasBurnSample}
          measuredBurnRateBaseUnitsPerSec={state.read.burnRateBaseUnitsPerSec}
        />
      ) : null}
    </div>
  );
}

function usdcInputStringFromBaseUnits(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = amount % 1_000_000n;
  if (fraction === 0n) return whole.toString();
  const fractionDigits = fraction
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole}.${fractionDigits}`;
}

/**
 * Opt-in auto-refill toggle + hard monthly ceiling (buzz#132, epic
 * toon-meta#261 decision 8). Enabling requires an explicit, confirmed
 * ceiling — a pre-filled suggestion is shown, but the switch never turns on
 * from a single click (owner decision recorded on the ticket: "no silent
 * default; the user must confirm or change the suggested value").
 */
function AutoRefillControl({
  agentPubkey,
  config,
  hasBurnSample,
  measuredBurnRateBaseUnitsPerSec,
}: {
  agentPubkey: string;
  config: ReturnType<typeof getAutoRefillConfig>;
  hasBurnSample: boolean;
  measuredBurnRateBaseUnitsPerSec: number;
}) {
  const [ceilingInput, setCeilingInput] = React.useState<string | null>(null);

  if (config.enabled) {
    return (
      <div
        className="flex items-center justify-between gap-2 px-1 pt-1"
        data-testid="user-profile-money-auto-refill-enabled"
      >
        <div className="flex items-center gap-2">
          <Switch
            aria-label="Auto-refill enabled"
            checked
            data-testid="user-profile-money-auto-refill-toggle"
            onCheckedChange={(checked) => {
              if (!checked)
                setAutoRefillConfig(agentPubkey, { enabled: false });
            }}
          />
          <span className="text-xs text-muted-foreground">
            Auto-refill tops up when runway runs low, up to your monthly
            ceiling.
          </span>
        </div>
      </div>
    );
  }

  if (ceilingInput === null) {
    return (
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <div className="flex items-center gap-2">
          <Switch
            aria-label="Auto-refill enabled"
            checked={false}
            data-testid="user-profile-money-auto-refill-toggle"
            onCheckedChange={(checked) => {
              if (!checked) return;
              const suggested = deriveSuggestedCeilingBaseUnits({
                measuredBurnRateBaseUnitsPerSec: hasBurnSample
                  ? measuredBurnRateBaseUnitsPerSec
                  : null,
                quotedWritePriceBaseUnits: null,
              });
              setCeilingInput(usdcInputStringFromBaseUnits(suggested));
            }}
          />
          <span className="text-xs text-muted-foreground">
            Auto-refill is off.
          </span>
        </div>
      </div>
    );
  }

  const parsedCeiling = parseUsdcAmount(ceilingInput);

  return (
    <div
      className="space-y-1 rounded-2xl bg-muted/20 px-3 py-2"
      data-testid="user-profile-money-auto-refill-setup"
    >
      <p className="text-xs text-muted-foreground">
        Set a monthly ceiling to enable auto-refill. This ceiling is tracked on
        this machine only — clearing local data resets it to full, so it's a
        safety bound, not a hard guarantee.
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Monthly auto-refill ceiling, in USDC"
          data-testid="user-profile-money-auto-refill-ceiling-input"
          inputMode="decimal"
          onChange={(event) => setCeilingInput(event.target.value)}
          placeholder="Ceiling in USDC"
          value={ceilingInput}
        />
        <Button
          data-testid="user-profile-money-auto-refill-confirm"
          disabled={parsedCeiling === null}
          onClick={() => {
            if (parsedCeiling === null) return;
            setAutoRefillConfig(agentPubkey, {
              enabled: true,
              ceilingBaseUnits: parsedCeiling,
            });
            setCeilingInput(null);
          }}
          size="sm"
          type="button"
        >
          Enable
        </Button>
        <Button
          data-testid="user-profile-money-auto-refill-cancel"
          onClick={() => setCeilingInput(null)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
