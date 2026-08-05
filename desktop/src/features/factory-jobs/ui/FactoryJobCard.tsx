import type * as React from "react";
import {
  AlertTriangle,
  Banknote,
  Briefcase,
  CheckCircle2,
  Loader2,
  MessageSquareText,
  PackageCheck,
  XCircle,
} from "lucide-react";

import {
  deriveFactoryJobCard,
  type FactoryJobCardVariant,
} from "@/features/factory-jobs/lib/factoryJobCard";
import type { TimelineMessage } from "@/features/messages/types";
import { cn } from "@/shared/lib/cn";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/shared/ui/attachment";

type FactoryJobCardProps = {
  className?: string;
  message: TimelineMessage;
  onOpenThread?: (message: TimelineMessage) => void;
};

const VARIANT_ICON: Record<
  FactoryJobCardVariant,
  React.ComponentType<{ className?: string }>
> = {
  request: Briefcase,
  "result-completed": CheckCircle2,
  "result-abandoned": XCircle,
  quote: Banknote,
  partial: PackageCheck,
  processing: Loader2,
  unrecognized: AlertTriangle,
};

const VARIANT_STATE: Record<
  FactoryJobCardVariant,
  "idle" | "processing" | "error" | "done"
> = {
  request: "idle",
  "result-completed": "done",
  "result-abandoned": "error",
  quote: "idle",
  partial: "processing",
  processing: "processing",
  unrecognized: "error",
};

/** Compact, labeled card for a NIP-90 factory job event (5097/6097/7000) landing in a channel timeline (buzz#125). */
export function FactoryJobCard({
  className,
  message,
  onOpenThread,
}: FactoryJobCardProps) {
  const card = deriveFactoryJobCard({
    id: message.id,
    pubkey: message.pubkey ?? message.signerPubkey ?? "",
    createdAt: message.createdAt,
    kind: message.kind ?? 0,
    content: message.body,
    tags: message.tags ?? [],
  });
  const Icon = VARIANT_ICON[card.variant];

  return (
    <Attachment
      className={cn("w-96 max-w-full shadow-none", className)}
      data-testid="factory-job-card"
      data-variant={card.variant}
      state={VARIANT_STATE[card.variant]}
    >
      <AttachmentMedia>
        <Icon className={cn(card.variant === "processing" && "animate-spin")} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{card.title}</AttachmentTitle>
        <AttachmentDescription>{card.description}</AttachmentDescription>
      </AttachmentContent>
      {onOpenThread ? (
        <AttachmentActions>
          <AttachmentAction
            aria-label="View job thread"
            onClick={() => onOpenThread(message)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <MessageSquareText className="h-4 w-4" />
            View thread
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  );
}
