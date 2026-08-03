import { CircleDollarSign, Coins, Sparkles, Wallet } from "lucide-react";

import {
  type AgentModelUsageSummary,
  formatModelUsageCostUsd,
  formatTokenCount,
  useAgentModelUsageQuery,
} from "@/features/profile/lib/agentModelUsage";
import {
  type ProfileField,
  ProfileFieldGroup,
} from "@/features/profile/ui/UserProfilePanelFields";

/**
 * Money tab (buzz#75): two blocks, deliberately never summed into one number.
 *
 * - Model usage (this ticket): LLM tokens, postpaid, estimated — billed to the
 *   owner's own provider account, where buzz cannot see it. No refill
 *   affordance; there is nothing here buzz could refill.
 * - Network spend (#80): USDC, prepaid, exact, enforcing — the only block
 *   that gets a refill action. Reserved as a sibling section below so #80
 *   lands beside this one rather than retrofitting the layout.
 */
export function ProfileMoneyTabContent({
  agentPubkey,
  ownerPubkey,
}: {
  agentPubkey: string;
  ownerPubkey: string | null;
}) {
  const usageQuery = useAgentModelUsageQuery(agentPubkey, ownerPubkey);

  return (
    <div className="space-y-4 pt-4" data-testid="user-profile-money-tab">
      <ModelUsageSection
        isError={usageQuery.isError}
        isPending={usageQuery.isPending}
        summary={usageQuery.data ?? null}
      />
      <NetworkSpendPlaceholder />
    </div>
  );
}

function buildModelUsageFields(
  summary: AgentModelUsageSummary,
): ProfileField[] {
  const fields: ProfileField[] = [];
  const hasTokens =
    summary.totalInputTokens !== null || summary.totalOutputTokens !== null;

  if (hasTokens) {
    const totalTokens =
      (summary.totalInputTokens ?? 0) + (summary.totalOutputTokens ?? 0);
    const hasBothCounts =
      summary.totalInputTokens !== null && summary.totalOutputTokens !== null;
    fields.push({
      displayValue: `${formatTokenCount(totalTokens)} tokens`,
      icon: Coins,
      label: "Tokens used",
      testId: "user-profile-money-tokens",
      trailingNode: hasBothCounts ? (
        <span className="text-xs text-muted-foreground">
          {formatTokenCount(summary.totalInputTokens as number)} in /{" "}
          {formatTokenCount(summary.totalOutputTokens as number)} out
        </span>
      ) : undefined,
    });
  }

  if (summary.totalCostUsd !== null) {
    fields.push({
      displayValue: formatModelUsageCostUsd(summary.totalCostUsd),
      icon: CircleDollarSign,
      label: "Estimated cost",
      testId: "user-profile-money-cost",
    });
  }

  if (summary.lastModel) {
    fields.push({
      displayValue: summary.lastModel,
      icon: Sparkles,
      label: "Last model",
      testId: "user-profile-money-model",
    });
  }

  return fields;
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
  const fields = summary ? buildModelUsageFields(summary) : [];

  return (
    <section className="space-y-2" data-testid="user-profile-money-model-usage">
      <h3 className="px-1 text-sm font-semibold text-foreground">
        Model usage
      </h3>
      {isPending ? (
        <p className="px-1 text-sm text-muted-foreground">
          Loading model usage…
        </p>
      ) : isError ? (
        <p
          className="px-1 text-sm text-muted-foreground"
          data-testid="user-profile-money-model-usage-error"
        >
          Model usage couldn't be loaded.
        </p>
      ) : fields.length === 0 ? (
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
      ) : (
        <ProfileFieldGroup fields={fields} />
      )}
      <p className="px-1 text-xs text-muted-foreground">
        Estimated from LLM token usage and billed to your provider account —
        buzz cannot see this spend.
      </p>
    </section>
  );
}

function NetworkSpendPlaceholder() {
  return (
    <section
      className="space-y-2"
      data-testid="user-profile-money-network-spend"
    >
      <h3 className="flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
        Network spend
        <span className="rounded-full bg-muted/70 px-2 py-0.5 text-2xs font-normal uppercase tracking-wide text-muted-foreground">
          Coming soon
        </span>
      </h3>
      <div className="flex items-center gap-3 rounded-2xl bg-muted/20 px-4 py-3">
        <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Balance, runway, and refill will land here — never summed with model
          usage above.
        </p>
      </div>
    </section>
  );
}
