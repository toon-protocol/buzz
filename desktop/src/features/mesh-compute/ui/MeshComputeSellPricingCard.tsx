import * as React from "react";

import {
  formatUsdcAmountInput,
  parseUsdcAmount,
} from "@/features/payments/lib/paymentsOverview";
import { SettingsOptionGroup } from "@/features/settings/ui/SettingsOptionGroup";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";
import { Input } from "@/shared/ui/input";
import { useMeshComputeSellPricing } from "../hooks/useMeshComputeSellPricing";
import {
  parseMaxOutputTokensInput,
  typicalJobCostBaseUnits,
  typicalJobCostCaption,
} from "../lib/meshComputeSellPricing";

/**
 * Settings → Compute → Posted price (buzz#165, part of the mesh-compute
 * epic toon-meta#265). Operator-facing knob for the `price` tag a future
 * kind:31990 advertisement would carry — no RFQ, no per-buyer negotiation
 * (epic decision 10), just a number and a ceiling the operator can revise
 * at any time.
 *
 * NOTE: neither the sell-compute mode (buzz#90) nor the kind:31990
 * publisher (buzz#91) exist yet, so a revision here updates the local
 * settings store (and its version counter) but has nothing to re-publish
 * to yet. See `meshComputeSellPricingStore.ts`'s module doc.
 */
export function MeshComputeSellPricingCard() {
  const { pricing, revise } = useMeshComputeSellPricing();
  const [priceInput, setPriceInput] = React.useState(() =>
    formatUsdcAmountInput(pricing.priceMicroUsdcPer1kTokens),
  );
  const [priceError, setPriceError] = React.useState<string | null>(null);
  const [tokensInput, setTokensInput] = React.useState(() =>
    String(pricing.maxOutputTokens),
  );
  const [tokensError, setTokensError] = React.useState<string | null>(null);

  function handlePriceChange(next: string) {
    setPriceInput(next);
    const parsed = parseUsdcAmount(next);
    if (parsed === null) {
      setPriceError("Enter a positive USDC amount, e.g. 0.002.");
      return;
    }
    setPriceError(null);
    revise({ ...pricing, priceMicroUsdcPer1kTokens: parsed });
  }

  function handleTokensChange(next: string) {
    setTokensInput(next);
    const parsed = parseMaxOutputTokensInput(next);
    if (parsed === null) {
      setTokensError("Enter a positive whole number of tokens.");
      return;
    }
    setTokensError(null);
    revise({ ...pricing, maxOutputTokens: parsed });
  }

  const typicalCostBaseUnits = typicalJobCostBaseUnits(
    pricing.priceMicroUsdcPer1kTokens,
    pricing.maxOutputTokens,
  );

  return (
    <section className="min-w-0" data-testid="settings-mesh-sell-pricing">
      <SettingsSectionHeader
        description={
          <>
            Set what this machine charges the open compute market per job.
            Revising the price takes effect for jobs quoted after the change —
            no restart needed.
          </>
        }
        title="Posted price"
      />

      <SettingsOptionGroup>
        <div className="flex flex-col gap-4 px-4 py-4">
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="mesh-sell-price-input"
            >
              Price
            </label>
            <div className="mt-2 flex items-center gap-2">
              <Input
                className="max-w-[10rem]"
                data-testid="mesh-sell-price-input"
                id="mesh-sell-price-input"
                inputMode="decimal"
                onChange={(e) => handlePriceChange(e.target.value)}
                value={priceInput}
              />
              <span className="text-sm text-muted-foreground">
                USDC per 1,000 output tokens
              </span>
            </div>
            {priceError ? (
              <p className="mt-1 text-sm text-destructive">{priceError}</p>
            ) : null}
          </div>

          <div>
            <label
              className="text-sm font-medium"
              htmlFor="mesh-sell-max-tokens-input"
            >
              Output token ceiling
            </label>
            <div className="mt-2 flex items-center gap-2">
              <Input
                className="max-w-[10rem]"
                data-testid="mesh-sell-max-tokens-input"
                id="mesh-sell-max-tokens-input"
                inputMode="numeric"
                onChange={(e) => handleTokensChange(e.target.value)}
                value={tokensInput}
              />
              <span className="text-sm text-muted-foreground">
                max output tokens per job
              </span>
            </div>
            {tokensError ? (
              <p className="mt-1 text-sm text-destructive">{tokensError}</p>
            ) : null}
          </div>

          <p
            className="text-sm text-muted-foreground"
            data-testid="mesh-sell-typical-cost"
          >
            {typicalJobCostCaption(
              typicalCostBaseUnits,
              pricing.maxOutputTokens,
            )}
          </p>
        </div>
      </SettingsOptionGroup>

      <p className="mt-3 rounded-lg bg-muted/30 px-3 py-2 text-sm font-normal text-muted-foreground">
        This is the inference price the buyer pays you directly. It is not the
        network's per-packet transfer fee — a separate, route-priced cost on a
        separate rail that never counts toward this number.
      </p>
    </section>
  );
}
