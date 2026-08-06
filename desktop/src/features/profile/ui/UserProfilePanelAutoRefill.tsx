import * as React from "react";

import { deriveSuggestedCeilingBaseUnits } from "@/features/agents/lib/agentAutoRefillPolicy";
import {
  type AutoRefillConfig,
  setAutoRefillConfig,
} from "@/features/agents/lib/agentAutoRefillStore";
import {
  formatUsdcAmountInput,
  parseUsdcAmount,
} from "@/features/payments/lib/paymentsOverview";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";

/**
 * Opt-in auto-refill toggle + hard monthly ceiling (buzz#132, epic
 * toon-meta#261 decision 8), rendered inside the Money tab's Network spend
 * block. Enabling requires an explicit, confirmed ceiling — a pre-filled
 * suggestion is shown, but the switch never turns on from a single click
 * (owner decision recorded on the ticket: "no silent default; the user must
 * confirm or change the suggested value").
 *
 * Three states, one per return below: enabled, off, and off-with-the-
 * ceiling-prompt-open (`ceilingInput !== null`).
 */
export function AutoRefillControl({
  agentPubkey,
  config,
  hasBurnSample,
  measuredBurnRateBaseUnitsPerSec,
}: {
  agentPubkey: string;
  config: AutoRefillConfig;
  hasBurnSample: boolean;
  measuredBurnRateBaseUnitsPerSec: number;
}) {
  const [ceilingInput, setCeilingInput] = React.useState<string | null>(null);

  if (config.enabled) {
    return (
      <AutoRefillToggleRow
        caption="Auto-refill tops up when runway runs low, up to your monthly ceiling."
        checked
        onCheckedChange={(checked) => {
          if (!checked) setAutoRefillConfig(agentPubkey, { enabled: false });
        }}
        testId="user-profile-money-auto-refill-enabled"
      />
    );
  }

  if (ceilingInput === null) {
    return (
      <AutoRefillToggleRow
        caption="Auto-refill is off."
        checked={false}
        onCheckedChange={(checked) => {
          // Turning the switch on only opens the ceiling prompt — the config
          // stays off until the operator confirms an amount.
          if (!checked) return;
          const suggested = deriveSuggestedCeilingBaseUnits({
            measuredBurnRateBaseUnitsPerSec: hasBurnSample
              ? measuredBurnRateBaseUnitsPerSec
              : null,
            quotedWritePriceBaseUnits: null,
          });
          setCeilingInput(formatUsdcAmountInput(suggested));
        }}
        testId="user-profile-money-auto-refill-off"
      />
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

function AutoRefillToggleRow({
  caption,
  checked,
  onCheckedChange,
  testId,
}: {
  caption: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2 px-1 pt-1" data-testid={testId}>
      <Switch
        aria-label="Auto-refill enabled"
        checked={checked}
        data-testid="user-profile-money-auto-refill-toggle"
        onCheckedChange={onCheckedChange}
      />
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}
