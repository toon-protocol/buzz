import * as React from "react";

import {
  meshInstalledModels,
  type MeshModelOption,
} from "@/shared/api/tauriMesh";
import { SettingsOptionGroup } from "@/features/settings/ui/SettingsOptionGroup";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";
import { useFeatureEnabled } from "@/shared/features";
import { Input } from "@/shared/ui/input";
import { classifyModelRef } from "../classifyModelRef";
import { useMeshComputeSellCapabilities } from "../hooks/useMeshComputeSellCapabilities";
import {
  MESH_COMPUTE_SELL_INGRESS_BASE_URL,
  parseMaxVramGbInput,
} from "../lib/meshComputeSellCapabilities";

/**
 * Settings → Compute → Sell capabilities (buzz#173, part of the mesh-compute
 * epic toon-meta#265). What the seller advertises: the model it runs and the
 * VRAM ceiling it claims. Split out of buzz#90 alongside the admission lock
 * (buzz#171) and the consent toggle (buzz#172).
 *
 * NOTE: neither buzz#172 (the sell-mode toggle, which actually starts a
 * `MeshAdmission::SelfOnly` node) nor buzz#91 (the kind:31990 publisher)
 * exist yet, so a revision here updates the local capabilities store (and
 * its version counter) but nothing consumes it yet — mirrors
 * `MeshComputeSellPricingCard.tsx`'s (buzz#165) same-shaped note.
 *
 * The VRAM ceiling recorded here is a claim, not an enforcement mechanism
 * (buzz#173 gotcha) — this card does not check it against real hardware.
 *
 * Gated behind `meshComputeSelling`, same preview feature as the pricing
 * card, for the same reason: ungated, it implies a market that nothing yet
 * advertises, quotes, or charges.
 */
export function MeshComputeSellCapabilitiesCard() {
  const sellingEnabled = useFeatureEnabled("meshComputeSelling");
  const { capabilities, revise } = useMeshComputeSellCapabilities();
  const [installedModels, setInstalledModels] = React.useState<
    MeshModelOption[]
  >([]);
  const [modelInput, setModelInput] = React.useState(
    () => capabilities.modelId ?? "",
  );
  const [vramInput, setVramInput] = React.useState(() =>
    capabilities.maxVramGb != null ? String(capabilities.maxVramGb) : "",
  );
  const [vramError, setVramError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await meshInstalledModels();
        if (!cancelled) setInstalledModels(list);
      } catch {
        // Non-fatal — picklist just stays empty; operator can still type a ref.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function pickModel(id: string) {
    setModelInput(id);
    revise({ ...capabilities, modelId: id });
  }

  function handleModelChange(next: string) {
    setModelInput(next);
    const classified = classifyModelRef(next);
    revise({
      ...capabilities,
      modelId: classified.kind === "unknown" ? null : next.trim(),
    });
  }

  function handleVramChange(next: string) {
    setVramInput(next);
    const parsed = parseMaxVramGbInput(next);
    if (parsed === null) {
      setVramError("Enter a positive number of GB.");
      return;
    }
    setVramError(null);
    revise({ ...capabilities, maxVramGb: parsed });
  }

  // After every hook, never before: an early return above the hooks/useState
  // calls would make the hook order depend on the flag.
  if (!sellingEnabled) return null;

  return (
    <section className="min-w-0" data-testid="settings-mesh-sell-capabilities">
      <SettingsSectionHeader
        description={
          <>
            Choose the model this machine runs for the open compute market and
            the VRAM ceiling it advertises. Buyers see these as this seller's
            capability listing.
          </>
        }
        title="Sell capabilities"
      />

      <SettingsOptionGroup>
        <div className="flex flex-col gap-4 px-4 py-4">
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="mesh-sell-model-input"
            >
              Model
            </label>
            <div className="mt-2">
              <Input
                data-testid="mesh-sell-model-input"
                id="mesh-sell-model-input"
                onChange={(e) => handleModelChange(e.target.value)}
                placeholder="Qwen3-8B-Q4_K_M or hf://meshllm/qwen3-8b@main"
                value={modelInput}
              />
            </div>
            {installedModels.length > 0 ? (
              <ul
                className="mt-1.5 flex flex-wrap gap-1.5"
                data-testid="mesh-sell-installed-list"
              >
                {installedModels.map((m) => (
                  <li key={m.id}>
                    <button
                      className="rounded border border-border/60 bg-muted/20 px-2 py-0.5 text-sm hover:bg-muted/40"
                      onClick={() => pickModel(m.id)}
                      type="button"
                    >
                      {m.name ?? m.id}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div>
            <label
              className="text-sm font-medium"
              htmlFor="mesh-sell-max-vram-input"
            >
              VRAM ceiling
            </label>
            <div className="mt-2 flex items-center gap-2">
              <Input
                className="max-w-[10rem]"
                data-testid="mesh-sell-max-vram-input"
                id="mesh-sell-max-vram-input"
                inputMode="decimal"
                onChange={(e) => handleVramChange(e.target.value)}
                value={vramInput}
              />
              <span className="text-sm text-muted-foreground">GB</span>
            </div>
            {vramError ? (
              <p className="mt-1 text-sm text-destructive">{vramError}</p>
            ) : (
              <p className="mt-1 text-sm font-normal text-muted-foreground">
                What this seller claims it can run. Buzz does not verify this
                against the machine's real hardware.
              </p>
            )}
          </div>
        </div>
      </SettingsOptionGroup>

      <p className="mt-3 rounded-lg bg-muted/30 px-3 py-2 text-sm font-normal text-muted-foreground">
        Paid job requests reach this machine at its local inference endpoint (
        {MESH_COMPUTE_SELL_INGRESS_BASE_URL}) — never exposed to the network.
      </p>
    </section>
  );
}
