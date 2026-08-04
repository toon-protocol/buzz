import { agentProvisioningStepNumber } from "@/features/agents/lib/agentProvisioningState";
import { useAgentProvisioning } from "@/features/agents/useAgentProvisioning";
import { formatUsdcBaseUnits } from "@/features/onboarding/toon/toonOnboardingFormat";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { StepProgress } from "@/shared/ui/step-progress";

/**
 * The provisioning-as-one-action flow (buzz#74): derive an agent's payment
 * key, fund it, and open its channel from inside the create-agent flow —
 * shown right after `SecretRevealDialog` hands off (see
 * `RequestedAgentCreateDialogs.tsx`), so an operator never has to run
 * separate CLI commands to make a freshly created agent able to pay.
 *
 * Mirrors `ToonOnboardingGate.tsx`'s shape: `StepProgress` plus one panel per
 * derived step, driven by `useAgentProvisioning`'s reality-derived status
 * (`agentProvisioningState.ts`) rather than a stored counter, so reopening
 * this dialog for an agent that is already partway funded resumes correctly.
 * Renders nothing once TOON is not the active transport, or once the agent
 * is fully provisioned.
 */
export function AgentProvisioningDialog({
  agent,
  onDismiss,
}: {
  agent: { pubkey: string; name: string } | null;
  onDismiss: () => void;
}) {
  const provisioning = useAgentProvisioning(agent?.pubkey ?? "");
  const open =
    agent !== null &&
    provisioning.active &&
    provisioning.status.step !== "done";

  return (
    <Dialog onOpenChange={(next) => !next && onDismiss()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Set up {agent?.name ?? "this agent"}'s wallet
          </DialogTitle>
          <DialogDescription>
            Derive a payment key, fund it from your own wallet, and open a
            payment channel so this agent can pay for TOON writes.
          </DialogDescription>
        </DialogHeader>

        <StepProgress
          className="mt-1"
          currentStep={agentProvisioningStepNumber(provisioning.status.step)}
          totalSteps={3}
        />

        <div className="mt-4">
          {provisioning.status.step === "key" ? (
            <p className="text-sm text-muted-foreground">
              Waiting for the agent's payment key to be assigned…
            </p>
          ) : provisioning.status.step === "fund" ? (
            <FundStep provisioning={provisioning} />
          ) : provisioning.status.step === "channel" ? (
            <ChannelStep provisioning={provisioning} />
          ) : null}
        </div>

        <div className="mt-4 flex justify-end">
          <Button onClick={onDismiss} type="button" variant="ghost">
            Do this later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FundStep({
  provisioning,
}: {
  provisioning: ReturnType<typeof useAgentProvisioning>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Sends native gas and USDC from your own wallet to this agent's derived
        address.
      </p>
      {provisioning.address ? (
        <div
          className="break-all rounded-lg bg-muted px-3 py-2 text-center font-mono text-xs text-foreground"
          data-testid="agent-provisioning-address"
        >
          {provisioning.address}
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-lg border border-input/40 px-3 py-2 text-xs">
        <span className="text-muted-foreground">USDC</span>
        <span>
          {provisioning.balances.tokenBaseUnits !== null
            ? formatUsdcBaseUnits(provisioning.balances.tokenBaseUnits)
            : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-input/40 px-3 py-2 text-xs">
        <span className="text-muted-foreground">Native gas</span>
        <span>{provisioning.status.hasNativeGas ? "funded" : "none yet"}</span>
      </div>

      {provisioning.status.needsManualGasTopUp ? (
        <Alert variant="default">
          <AlertDescription>
            USDC arrived, but the gas transfer didn't land this time — retry, or
            send a small amount of native gas to the address above by hand.
          </AlertDescription>
        </Alert>
      ) : null}
      {provisioning.fundError ? (
        <Alert variant="destructive">
          <AlertDescription>{provisioning.fundError}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        data-testid="agent-provisioning-fund"
        disabled={provisioning.fundLoading || !provisioning.address}
        onClick={() => void provisioning.fund()}
        type="button"
      >
        {provisioning.fundLoading ? "Funding…" : "Fund this agent"}
      </Button>
    </div>
  );
}

function ChannelStep({
  provisioning,
}: {
  provisioning: ReturnType<typeof useAgentProvisioning>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Opening a payment channel locks{" "}
        <strong className="text-foreground">
          {provisioning.balances.tokenBaseUnits !== null
            ? formatUsdcBaseUnits(provisioning.balances.tokenBaseUnits)
            : "the funded amount"}
        </strong>{" "}
        as collateral — released when the channel is closed. This is an on-chain
        transaction.
      </p>
      {provisioning.channelError ? (
        <Alert variant="destructive">
          <AlertDescription>{provisioning.channelError}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        data-testid="agent-provisioning-open-channel"
        disabled={provisioning.channelLoading}
        onClick={() => void provisioning.openChannel()}
        type="button"
      >
        {provisioning.channelLoading ? "Opening…" : "Open payment channel"}
      </Button>
    </div>
  );
}
