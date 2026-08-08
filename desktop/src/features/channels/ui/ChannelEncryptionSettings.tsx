import { KeyRound, Lock, LockOpen, RefreshCw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { isChannelAdmin } from "@/shared/api/channelAdminList";
import {
  getChannelAdminList,
  subscribeToChannelAdminLists,
} from "@/shared/api/channelAdminListStore";
import {
  type ChannelKey,
  formatChannelKey,
  generateChannelKey,
  parseChannelKey,
  channelKeyId,
} from "@/shared/api/channelEncryption";
import {
  getChannelKey,
  setChannelKey,
  subscribeToChannelKeys,
} from "@/shared/api/channelKeyStore";
import { announceChannelKey } from "@/shared/api/channelMembership";
import { useIdentityQuery } from "@/shared/api/hooks";
import { ChannelAdminList } from "@/features/channels/ui/ChannelAdminList";
import { useRotateChannelKeyMutation } from "@/features/channels/hooks";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/**
 * A channel's key and the admins entitled to hand it out.
 *
 * The paste field is no longer the delivery mechanism — buzz#16 gift-wraps the
 * key to each new member and the recipient's client unlocks the channel by
 * itself. It stays as the manual override, because the automatic path has
 * three ways to leave a member keyless that are none of their doing: a channel
 * created before this feature has no admin list, an admin whose paid write
 * failed sent nothing, and a client whose keyring was locked at launch never
 * started its inbox. In all three the answer is a human reading hex to another
 * human, and removing the field would remove the recovery path.
 *
 * The admin list above it is what makes the automatic path trustworthy, so it
 * is shown here rather than buried: those are the identities that can silently
 * add a reader to this channel.
 *
 * The key is shown in full rather than masked. It has to leave this screen by
 * hand for the feature to work at all, and a masked field the user must reveal
 * to use is security theatre, not a control.
 */
export function ChannelEncryptionSettings({
  channelId,
  disabled,
  testIdPrefix,
}: {
  channelId: string;
  disabled?: boolean;
  testIdPrefix: string;
}) {
  const storedKeyHex = useChannelKeyHex(channelId);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const applyKey = (value: string) => {
    const parsed = parseChannelKey(value);
    if (!parsed) {
      setError("That is not a channel key — expected 64 hex characters.");
      return;
    }
    setChannelKey(channelId, parsed);
    announceKey(channelId, parsed);
    setDraft("");
    setError(null);
    toast.success("Channel key saved. New messages here are encrypted.");
  };

  return (
    <div
      className="space-y-3 rounded-xl border border-input bg-background px-3 py-3"
      data-testid={`${testIdPrefix}-encryption-container`}
    >
      <div className="flex items-center gap-2">
        {storedKeyHex ? (
          <Lock className="size-4 text-foreground" />
        ) : (
          <LockOpen className="size-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium text-foreground">Encryption</span>
      </div>

      <ChannelAdminList channelId={channelId} testIdPrefix={testIdPrefix} />

      {storedKeyHex ? (
        <KeyedState
          channelId={channelId}
          disabled={disabled}
          keyHex={storedKeyHex}
          testIdPrefix={testIdPrefix}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          This channel is unencrypted: the relay serves its messages to anyone
          who asks. Paste a shared channel key to seal what you send and open
          what other members send.
        </p>
      )}

      <div className="flex gap-2">
        <Input
          aria-label="Channel key"
          className={cn("font-mono text-xs", error && "border-destructive")}
          data-testid={`${testIdPrefix}-encryption-key-input`}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") applyKey(draft);
          }}
          placeholder={
            storedKeyHex ? "Replace with another key" : "Paste the channel key"
          }
          value={draft}
        />
        <Button
          data-testid={`${testIdPrefix}-encryption-save`}
          disabled={disabled || draft.trim().length === 0}
          onClick={() => applyKey(draft)}
          size="sm"
          type="button"
        >
          Save
        </Button>
      </div>

      {error ? (
        <p
          className="text-xs text-destructive"
          data-testid={`${testIdPrefix}-encryption-error`}
        >
          {error}
        </p>
      ) : null}

      {storedKeyHex ? null : (
        <Button
          className="gap-2"
          data-testid={`${testIdPrefix}-encryption-generate`}
          disabled={disabled}
          onClick={() => {
            const generated = generateChannelKey();
            setChannelKey(channelId, generated);
            announceKey(channelId, generated);
            toast.success("Channel key generated. Members will be sent it.");
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <KeyRound className="size-4" />
          Generate a key
        </Button>
      )}
    </div>
  );
}

function KeyedState({
  channelId,
  disabled,
  keyHex,
  testIdPrefix,
}: {
  channelId: string;
  disabled?: boolean;
  keyHex: string;
  testIdPrefix: string;
}) {
  const parsed = parseChannelKey(keyHex);
  const adminList = useChannelAdminListSnapshot(channelId);
  const identity = useIdentityQuery();
  const canRotate = isChannelAdmin(adminList, identity.data?.pubkey);
  const rotateMutation = useRotateChannelKeyMutation(channelId);

  async function handleRotateNow() {
    try {
      await rotateMutation.mutateAsync();
      toast.success("Channel key rotated. Members will be sent the new key.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to rotate the channel key.",
      );
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Messages you send here are NIP-44 encrypted with this key. Everyone
        without it — including the relay — sees ciphertext. Anyone you give it
        to can read the channel's whole history.
      </p>
      <div
        className="break-all rounded-lg bg-muted px-2 py-2 font-mono text-xs text-foreground"
        data-testid={`${testIdPrefix}-encryption-key`}
      >
        {keyHex}
      </div>
      {parsed ? (
        <p className="text-xs text-muted-foreground">
          Key {channelKeyId(parsed)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid={`${testIdPrefix}-encryption-copy`}
          disabled={disabled}
          onClick={() => copyTextToClipboard(keyHex, "Channel key copied")}
          size="sm"
          type="button"
          variant="outline"
        >
          Copy key
        </Button>
        <Button
          data-testid={`${testIdPrefix}-encryption-remove`}
          disabled={disabled}
          onClick={() => {
            setChannelKey(channelId, null);
            toast.success("Channel key removed from this client.");
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Forget key
        </Button>
        {canRotate ? (
          // The "this key may have leaked" trigger (buzz#42): rotate on
          // demand with no removal riding along, for the admin who suspects
          // the key reached someone who should not have it and cannot wait
          // for the next membership change to fix that.
          <Button
            className="gap-2"
            data-testid={`${testIdPrefix}-encryption-rotate`}
            disabled={disabled || rotateMutation.isPending}
            onClick={() => void handleRotateNow()}
            size="sm"
            type="button"
            variant="outline"
          >
            <RefreshCw className="size-4" />
            {rotateMutation.isPending ? "Rotating..." : "Rotate now"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The validated admin list, re-rendering when a new signed one arrives. */
function useChannelAdminListSnapshot(channelId: string) {
  const snapshot = React.useCallback(
    () => getChannelAdminList(channelId),
    [channelId],
  );
  return React.useSyncExternalStore(
    subscribeToChannelAdminLists,
    snapshot,
    snapshot,
  );
}

/**
 * Tell the channel's admin list which key epoch is now current.
 *
 * Fire-and-forget: the key is already saved locally and the channel already
 * encrypts with it, so a paid write that has not landed must not make the
 * button feel broken. A no-op for anyone who is not an admin of a validated
 * list — including the common case of pasting a key someone shared out of
 * band, where the announcement is not this client's to make.
 */
function announceKey(channelId: string, key: ChannelKey): void {
  void announceChannelKey(channelId, key)
    .then((publication) => publication?.published)
    .catch((error) => {
      console.warn(
        `[channel-keys] could not announce ${channelId}'s key epoch`,
        error,
      );
    });
}

/**
 * The stored key as hex, re-rendering when it changes.
 *
 * Snapshots to a string rather than the bytes so `useSyncExternalStore`'s
 * equality check is value-based — a fresh `Uint8Array` on every read would
 * loop.
 */
function useChannelKeyHex(channelId: string): string | null {
  const snapshot = React.useCallback(() => {
    const key = getChannelKey(channelId);
    return key ? formatChannelKey(key) : null;
  }, [channelId]);
  return React.useSyncExternalStore(subscribeToChannelKeys, snapshot, snapshot);
}
