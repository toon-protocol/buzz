import { CircleDollarSign, Coins, Sparkles } from "lucide-react";

import {
  type AgentModelUsageSummary,
  formatModelUsageCostUsd,
  formatTokenCount,
  useAgentModelUsageQuery,
} from "@/features/profile/lib/agentModelUsage";
import { useNetworkSpend } from "@/features/profile/lib/useNetworkSpend";
import {
  type ProfileField,
  ProfileFieldGroup,
} from "@/features/profile/ui/UserProfilePanelFields";
import { NetworkSpendSection } from "@/features/profile/ui/UserProfilePanelNetworkSpend";
import { SpendAttributionSection } from "@/features/profile/ui/UserProfilePanelSpendAttribution";

/**
 * Money tab (buzz#75 + #80): two blocks, deliberately never summed into one
 * number.
 *
 * - Model usage: LLM tokens, postpaid, estimated — billed to the owner's own
 *   provider account, where buzz cannot see it. No refill affordance; there
 *   is nothing here buzz could refill.
 * - Network spend (this ticket): USDC, prepaid, exact, enforcing — the only
 *   block that gets a refill action.
 */
export function ProfileMoneyTabContent({
  agentPubkey,
  isSelf,
  ownerPubkey,
}: {
  agentPubkey: string;
  isSelf: boolean;
  ownerPubkey: string | null;
}) {
  const usageQuery = useAgentModelUsageQuery(agentPubkey, ownerPubkey);
  const network = useNetworkSpend(agentPubkey, isSelf);

  return (
    <div className="space-y-4 pt-4" data-testid="user-profile-money-tab">
      <ModelUsageSection
        isError={usageQuery.isError}
        isPending={usageQuery.isPending}
        summary={usageQuery.data ?? null}
      />
      <NetworkSpendSection
        agentPubkey={agentPubkey}
        isSelf={isSelf}
        network={network}
      />
      <SpendAttributionSection
        agentPubkey={agentPubkey}
        isSelf={isSelf}
        network={network.state}
      />
    </div>
  );
}

function buildModelUsageFields(
  summary: AgentModelUsageSummary,
): ProfileField[] {
  const fields: ProfileField[] = [];
  const { totalInputTokens, totalOutputTokens, totalCostUsd, lastModel } =
    summary;

  if (totalInputTokens !== null || totalOutputTokens !== null) {
    const totalTokens = (totalInputTokens ?? 0) + (totalOutputTokens ?? 0);
    fields.push({
      displayValue: `${formatTokenCount(totalTokens)} tokens`,
      icon: Coins,
      label: "Tokens used",
      testId: "user-profile-money-tokens",
      trailingNode:
        totalInputTokens !== null && totalOutputTokens !== null ? (
          <span className="text-xs text-muted-foreground">
            {formatTokenCount(totalInputTokens)} in /{" "}
            {formatTokenCount(totalOutputTokens)} out
          </span>
        ) : undefined,
    });
  }

  if (totalCostUsd !== null) {
    fields.push({
      displayValue: formatModelUsageCostUsd(totalCostUsd),
      icon: CircleDollarSign,
      label: "Estimated cost",
      testId: "user-profile-money-cost",
    });
  }

  if (lastModel) {
    fields.push({
      displayValue: lastModel,
      icon: Sparkles,
      label: "Last model",
      testId: "user-profile-money-model",
    });
  }

  return fields;
}

function ModelUsageBody({
  isError,
  isPending,
  summary,
}: {
  isError: boolean;
  isPending: boolean;
  summary: AgentModelUsageSummary | null;
}) {
  if (isPending) {
    return (
      <p className="px-1 text-sm text-muted-foreground">Loading model usage…</p>
    );
  }

  if (isError) {
    return (
      <p
        className="px-1 text-sm text-muted-foreground"
        data-testid="user-profile-money-model-usage-error"
      >
        Model usage couldn't be loaded.
      </p>
    );
  }

  const fields = summary ? buildModelUsageFields(summary) : [];
  if (fields.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center px-6 py-8 text-center"
        data-testid="user-profile-money-model-usage-empty"
      >
        <Coins className="mx-auto h-4 w-4 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">No usage recorded yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Token usage appears here after this agent completes a turn.
        </p>
      </div>
    );
  }

  return <ProfileFieldGroup fields={fields} />;
}

function ModelUsageSection({
  isError,
  isPending,
  summary,
}: {
  isError: boolean;
  isPending: boolean;
  summary: AgentModelUsageSummary | null;
}) {
  return (
    <section className="space-y-2" data-testid="user-profile-money-model-usage">
      <h3 className="px-1 text-sm font-semibold text-foreground">
        Model usage
      </h3>
      <ModelUsageBody
        isError={isError}
        isPending={isPending}
        summary={summary}
      />
      <p className="px-1 text-xs text-muted-foreground">
        Estimated from LLM token usage and billed to your provider account —
        buzz cannot see this spend.
      </p>
    </section>
  );
}
