import * as React from "react";

import {
  type ProviderCapabilitySettings,
  setProviderCapabilitySettings,
} from "@/features/providers/lib/providerCapabilitySettings";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

/**
 * Advertise a capability (buzz#84 "What" §1): a plain local toggle, no
 * approval step — decision 14 (toon-meta#262) makes provider eligibility
 * permissionless, so this surface must not feel like a request that goes
 * anywhere. Flipping it on immediately starts matching the inbound feed.
 */
export function ProviderCapabilityToggle({
  pubkey,
  settings,
}: {
  pubkey: string;
  settings: ProviderCapabilitySettings;
}) {
  const [repoFilterInput, setRepoFilterInput] = React.useState(
    settings.repoFilter.join(", "),
  );

  const update = (next: Partial<ProviderCapabilitySettings>) => {
    setProviderCapabilitySettings(pubkey, { ...settings, ...next });
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          checked={settings.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
          type="checkbox"
        />
        Serve jobs from the open factory job market
      </label>
      <Textarea
        aria-label="What this agent serves"
        disabled={!settings.enabled}
        onChange={(event) => update({ description: event.target.value })}
        placeholder="What this agent serves — shown to a buyer once you quote (e.g. TypeScript refactors, small to medium)"
        value={settings.description}
      />
      <div className="flex flex-col gap-1">
        <Input
          aria-label="Repo filter (optional)"
          disabled={!settings.enabled}
          onBlur={() =>
            update({
              repoFilter: repoFilterInput
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            })
          }
          onChange={(event) => setRepoFilterInput(event.target.value)}
          placeholder="Only quote jobs naming these repos (comma-separated, blank = any)"
          value={repoFilterInput}
        />
        <span className="text-xs text-muted-foreground">
          Leave blank to see every open job regardless of which repo it names.
        </span>
      </div>
    </div>
  );
}
