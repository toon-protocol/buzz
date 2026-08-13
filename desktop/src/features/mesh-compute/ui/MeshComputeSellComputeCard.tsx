import * as React from "react";

import { meshStartNode, meshStopNode } from "@/shared/api/tauriMesh";
import type { MeshNodeStatus } from "@/shared/api/tauriMesh";
import {
  SettingsOptionGroup,
  SettingsOptionRow,
} from "@/features/settings/ui/SettingsOptionGroup";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";
import { Switch } from "@/shared/ui/switch";
import { useFeatureEnabled } from "@/shared/features";
import { classifyModelRef } from "../classifyModelRef";
import { readMeshModelDraft } from "../modelDraft";
import { useMeshNodeStatus } from "../hooks/useMeshNodeStatus";
import { deriveMeshSellToggle } from "../sellToggleState";

/**
 * Settings → Compute → Sell compute (buzz#172, split out of buzz#90's
 * consent surface). Independent of `MeshComputeSettingsCard`'s free,
 * relay-scoped "Share compute" switch — this one drives the buzz#171
 * sell-compute serve mode (mesh admission locked to self) that paid,
 * anonymous market buyers reach through the DVM, never through the mesh
 * itself.
 *
 * The consent copy here is deliberately its own wording, not a paraphrase of
 * Share compute's: this switch is agreeing to a different deal (strangers
 * who paid, not relay members) and the copy is the product's honesty
 * surface for that deal.
 *
 * Gated behind the `meshComputeSelling` preview feature — nothing
 * advertises, quotes, or charges yet (buzz#91 is the publisher); this only
 * starts/stops the local serving mode a future listing would route jobs to.
 */
export function MeshComputeSellComputeCard() {
  const sellingEnabled = useFeatureEnabled("meshComputeSelling");
  const { status, error, refresh } = useMeshNodeStatus();
  const [actionInFlight, setActionInFlight] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<
    "start" | "stop" | null
  >(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // Read once at mount, not reactively: Sell compute does not own this
  // value (Share compute does), so a mid-session edit over there is a rare
  // case, and re-reading fresh at click time (below) keeps the actual start
  // call correct regardless of what's displayed.
  const [modelDraft] = React.useState(() => readMeshModelDraft());

  const { isSelling, blockedByOther } = deriveMeshSellToggle(status);
  const modelKind = classifyModelRef(modelDraft);
  const hasModel = modelKind.kind !== "unknown";

  async function handleToggle(next: boolean) {
    // Never let the Sell switch tear down a runtime it doesn't own. Belt-
    // and-braces: the switch is already disabled while blocked, but status
    // can be stale between polls.
    if (!next && !isSelling) {
      return;
    }
    setActionError(null);
    setPendingAction(next ? "start" : "stop");
    setActionInFlight(true);
    try {
      if (next) {
        await meshStartNode({
          mode: "serve",
          admission: "self_only",
          modelId: readMeshModelDraft().trim() || undefined,
        });
      } else {
        await meshStopNode();
      }
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionInFlight(false);
      setPendingAction(null);
    }
  }

  // After every hook, never before: an early return above the hooks would
  // make hook order depend on the flag.
  if (!sellingEnabled) return null;

  return (
    <section className="min-w-0" data-testid="settings-mesh-sell-compute">
      <SettingsSectionHeader
        title="Sell compute"
        description={
          <>
            A different deal from Share compute: paid, anonymous strangers — not
            people you know from this relay — send inference jobs to run on this
            machine through the open compute market.
          </>
        }
      />

      {error ? (
        <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn't check sell status: {error}
        </p>
      ) : null}
      {actionError ? (
        <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <SettingsOptionGroup>
        <SettingsOptionRow>
          <div className="min-w-0">
            <label
              className="text-sm font-medium"
              htmlFor="mesh-sell-compute-toggle"
            >
              Sell this machine's compute
            </label>
            <StatusLine
              blockedByOther={blockedByOther}
              hasModel={hasModel}
              modelDraft={modelDraft}
              pendingAction={pendingAction}
              status={status}
            />
          </div>
          <Switch
            checked={isSelling}
            data-testid="mesh-sell-compute-toggle"
            disabled={
              actionInFlight ||
              (isSelling ? false : blockedByOther || !hasModel)
            }
            id="mesh-sell-compute-toggle"
            onCheckedChange={handleToggle}
          />
        </SettingsOptionRow>
      </SettingsOptionGroup>

      <p className="mt-3 rounded-lg bg-muted/30 px-3 py-2 text-sm font-normal text-muted-foreground">
        When on, anyone who pays through the open compute market can send jobs
        here — you aren't shown who they are, and you can't vet them the way
        you'd vet a relay member. Preview: nothing is advertised or charged
        automatically yet — this only starts the local serving mode a future
        market listing will route jobs to.
      </p>
    </section>
  );
}

function StatusLine({
  blockedByOther,
  hasModel,
  modelDraft,
  pendingAction,
  status,
}: {
  blockedByOther: boolean;
  hasModel: boolean;
  modelDraft: string;
  pendingAction: "start" | "stop" | null;
  status: MeshNodeStatus | null;
}) {
  if (pendingAction === "start") {
    return <p className="text-sm text-muted-foreground">Starting…</p>;
  }
  if (pendingAction === "stop") {
    return <p className="text-sm text-muted-foreground">Stopping…</p>;
  }
  if (blockedByOther) {
    return (
      <p className="text-sm text-muted-foreground">
        Turn off Share compute (or stop using another member's shared compute)
        to sell instead — this machine serves one model at a time.
      </p>
    );
  }
  if (!hasModel) {
    return (
      <p className="text-sm text-muted-foreground">
        Choose a model in Share compute above, then come back to sell it.
      </p>
    );
  }
  if (!status) {
    return <p className="text-sm text-muted-foreground">Checking status…</p>;
  }
  const { state, health } = status;
  if (state === "off") {
    return (
      <p className="text-sm text-muted-foreground">Not selling right now.</p>
    );
  }
  if (state === "starting") {
    const reason =
      health.status === "degraded" || health.status === "failed"
        ? health.reason
        : "Starting…";
    return <p className="text-sm text-muted-foreground">{reason}</p>;
  }
  if (state === "running") {
    if (health.status === "failed") {
      return (
        <p className="text-sm text-destructive">
          Couldn't load: {health.reason}
        </p>
      );
    }
    if (health.status === "degraded") {
      return (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Selling {modelDraft}. {health.reason}
        </p>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        Selling {modelDraft} to the open compute market.
      </p>
    );
  }
  if (state === "stopping") {
    return <p className="text-sm text-muted-foreground">Stopping…</p>;
  }
  if (state === "failed") {
    const reason =
      health.status === "failed" || health.status === "degraded"
        ? health.reason
        : "Couldn't start.";
    return <p className="text-sm text-destructive">{reason}</p>;
  }
  return null;
}
