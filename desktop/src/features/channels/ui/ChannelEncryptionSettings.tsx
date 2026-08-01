import { KeyRound, Lock, LockOpen } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
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
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/**
 * The out-of-band key handoff, as a form.
 *
 * This is deliberately the crudest possible key distribution: one member
 * generates a key here, reads the hex out, and every other member pastes it
 * into the same field. Gift-wrapped delivery and admin-triggered rotation
 * replace this; until they exist, a human is the transport, and pretending
 * otherwise in the UI would be dishonest about what the channel's privacy
 * currently rests on.
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
            setChannelKey(channelId, generateChannelKey());
            toast.success("Channel key generated. Share it with the members.");
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
      </div>
    </div>
  );
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
