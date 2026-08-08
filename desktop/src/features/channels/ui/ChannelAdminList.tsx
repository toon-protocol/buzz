import { ShieldCheck, ShieldQuestion } from "lucide-react";

import { useIdentityQuery } from "@/shared/api/hooks";
import { useChannelAdminList } from "@/features/channels/useChannelAdminList";

/**
 * Who may hand out this channel's key, rendered from the signed admin list.
 *
 * Every name here came out of a signature chain this client validated itself
 * (`channelAdminList.resolveChannelAdminList`) — the relay's own 39001 admin
 * list is not consulted and could not be believed if it were (ADR 0001). The
 * panel exists so that statement is visible rather than merely true: a member
 * can see which identities their channel's privacy actually depends on.
 *
 * "No admin list" is a real and expected state, not an error: channels created
 * before buzz#16, and channels whose list has not arrived from the relay yet.
 * Said plainly, because it is also the state in which a gift-wrapped key would
 * be held rather than accepted.
 */
export function ChannelAdminList({
  channelId,
  testIdPrefix,
}: {
  channelId: string;
  testIdPrefix: string;
}) {
  const adminList = useChannelAdminList(channelId);
  const identity = useIdentityQuery();
  const self = identity.data?.pubkey ?? null;

  if (!adminList) {
    return (
      <div
        className="flex items-start gap-2 text-xs text-muted-foreground"
        data-testid={`${testIdPrefix}-admin-list-missing`}
      >
        <ShieldQuestion className="mt-0.5 size-4 shrink-0" />
        <span>
          No signed admin list for this channel yet. Until one arrives, a
          channel key someone sends you is held rather than trusted — there is
          nobody to check the sender against.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-admin-list`}>
      <div className="flex items-center gap-2 text-xs text-foreground">
        <ShieldCheck className="size-4" />
        <span>
          {adminList.admins.length === 1
            ? "1 admin can share this channel's key"
            : `${adminList.admins.length} admins can share this channel's key`}
        </span>
      </div>
      <ul className="space-y-1">
        {adminList.admins.map((pubkey) => (
          <li
            className="flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground"
            key={pubkey}
          >
            <span className="truncate">{pubkey}</span>
            <span className="shrink-0 font-sans text-2xs uppercase tracking-wide">
              {pubkey === adminList.creator ? "creator" : "admin"}
              {pubkey === self ? " · you" : ""}
            </span>
          </li>
        ))}
      </ul>
      {adminList.keyId ? (
        <p className="text-xs text-muted-foreground">
          Current key {adminList.keyId} (epoch {adminList.epoch})
        </p>
      ) : null}
    </div>
  );
}
