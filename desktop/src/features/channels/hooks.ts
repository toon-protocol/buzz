import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addChannelMembers,
  archiveChannel,
  createChannel,
  deleteChannel,
  getCanvas,
  getChannelDetails,
  getChannelMembers,
  getChannels,
  hideDm,
  joinChannel,
  leaveChannel,
  openDm,
  removeChannelMember,
  setCanvas,
  setChannelPurpose,
  setChannelTopic,
  unarchiveChannel,
  updateChannel,
} from "@/shared/api/tauri";
import type {
  AddChannelMembersInput,
  Channel,
  ChannelDetail,
  CreateChannelInput,
  OpenDmInput,
  SetChannelPurposeInput,
  SetChannelTopicInput,
  UpdateChannelInput,
} from "@/shared/api/types";
import {
  type ChannelKeyRotationOutcome,
  type ChannelKeyRotationRefusal,
  rotateChannelKeyForRemoval,
} from "@/shared/api/channelKeyRotation";
import { hasChannelKey } from "@/shared/api/channelKeyStore";
import {
  grantChannelKeyToMembers,
  provisionPrivateChannel,
} from "@/shared/api/channelMembership";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { useCommunities } from "@/features/communities/useCommunities";
import {
  readChannelSnapshot,
  writeChannelSnapshot,
} from "@/features/channels/channelSnapshot";

export const channelsQueryKey = ["channels"] as const;
const channelDetailQueryKey = (channelId: string) =>
  ["channels", channelId, "detail"] as const;
const channelMembersQueryKey = (channelId: string) =>
  ["channels", channelId, "members"] as const;
const channelTypeOrder = {
  stream: 0,
  forum: 1,
  dm: 2,
} as const;

function sortChannels(channels: Channel[]) {
  const uniqueChannels = new Map<string, Channel>();

  for (const channel of channels) {
    uniqueChannels.set(channel.id, channel);
  }

  return [...uniqueChannels.values()].sort((left, right) => {
    const typeOrder =
      channelTypeOrder[left.channelType] - channelTypeOrder[right.channelType];

    if (typeOrder !== 0) {
      return typeOrder;
    }

    return left.name.localeCompare(right.name);
  });
}

export type CachedChannelMember = {
  membershipAdded: boolean;
  name: string;
  pubkey: string;
};

/**
 * Records a successful membership mutation in the shared channel list before
 * its read-after-write refetch completes. DM participant sets are immutable,
 * so adding a member there creates a separate conversation and must never
 * decorate the source channel optimistically. Exported for focused cache race
 * regression coverage.
 */
export function upsertCachedChannelMember(
  current: Channel[] | undefined,
  channelId: string,
  member: CachedChannelMember,
): Channel[] | undefined {
  if (!current) {
    return current;
  }

  const normalizedPubkey = member.pubkey.toLowerCase();
  return sortChannels(
    current.map((channel) => {
      if (channel.id !== channelId) {
        return channel;
      }

      if (channel.channelType === "dm") {
        return channel;
      }

      const hasMember = channel.memberPubkeys.some(
        (pubkey) => pubkey.toLowerCase() === normalizedPubkey,
      );
      const memberPubkeys = hasMember
        ? channel.memberPubkeys
        : [...channel.memberPubkeys, member.pubkey];
      return {
        ...channel,
        memberCount: Math.max(
          memberPubkeys.length,
          channel.memberCount + (member.membershipAdded && !hasMember ? 1 : 0),
        ),
        memberPubkeys,
      };
    }),
  );
}

/**
 * Adds or replaces a relay-returned channel in a possibly stale channel list.
 * Exported for focused cache race regression coverage.
 */
export function upsertCachedChannel(
  current: Channel[] | undefined,
  channel: Channel,
): Channel[] {
  return sortChannels([
    ...(current ?? []).filter((candidate) => candidate.id !== channel.id),
    channel,
  ]);
}

/**
 * Reconciles a relay-returned channel after a list refresh. When the refresh
 * already contains the immutable DM, its current metadata wins over the older
 * snapshot used to open the route. Otherwise the opened channel repairs the
 * route after a read-after-write-lagged list response.
 */
export function reconcileRefreshedCachedChannel(
  refreshed: Channel[] | undefined,
  channel: Channel,
): Channel[] {
  const refreshedChannel = refreshed?.find(
    (candidate) => candidate.id === channel.id,
  );
  return upsertCachedChannel(refreshed, refreshedChannel ?? channel);
}

export async function invalidateChannelState(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string | null | undefined,
) {
  await queryClient.invalidateQueries({ queryKey: channelsQueryKey });

  if (!channelId) {
    return;
  }

  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: channelDetailQueryKey(channelId),
    }),
    queryClient.invalidateQueries({
      queryKey: channelMembersQueryKey(channelId),
    }),
  ]);
}

function setChannelArchivedState(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string,
  archivedAt: string | null,
) {
  queryClient.setQueryData<Channel[]>(channelsQueryKey, (current = []) =>
    sortChannels(
      current.map((channel) =>
        channel.id === channelId ? { ...channel, archivedAt } : channel,
      ),
    ),
  );

  queryClient.setQueryData<ChannelDetail | undefined>(
    channelDetailQueryKey(channelId),
    (current) => (current ? { ...current, archivedAt } : current),
  );
}

export function useChannelsQuery(options?: { enabled?: boolean }) {
  const { activeCommunity } = useCommunities();
  const relayUrl = activeCommunity?.relayUrl ?? null;

  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: channelsQueryKey,
    queryFn: async () => {
      const channels = sortChannels(await getChannels());
      if (relayUrl) {
        writeChannelSnapshot(relayUrl, channels);
      }
      return channels;
    },
    // Paint the sidebar instantly from the last-known list for this relay, then
    // revalidate. initialDataUpdatedAt:0 marks the seed as already-stale so the
    // background refetch still fires immediately.
    initialData: relayUrl
      ? () => {
          const snapshot = readChannelSnapshot(relayUrl);
          return snapshot ? sortChannels(snapshot) : undefined;
        }
      : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useCreateChannelMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateChannelInput) => {
      const created = await createChannel(input);
      // A private channel is born with a key and a signed admin list naming
      // its creator (ADR 0001, buzz#16).
      //
      // The signing is awaited — the member picker opens straight after this
      // resolves, and an add-member that beats the admin list has no authority
      // to gift-wrap under. The *publish* is not: it is a paid write to a
      // relay this dialog should not be held open behind, and nothing the
      // creator's own client does next depends on it having landed.
      //
      // Neither failure may lose the channel the relay already created. It
      // exists, keyless and listless, and channel settings say so — the manual
      // paste field is still the way its members get in.
      try {
        const provisioned = await provisionPrivateChannel(created);
        provisioned?.published.catch((error) => {
          console.warn(
            `[channel-keys] ${created.id}'s admin list did not reach the relay`,
            error,
          );
        });
      } catch (error) {
        console.warn(
          `[channel-keys] ${created.id} created without an admin list`,
          error,
        );
      }
      return created;
    },
    onSuccess: (createdChannel) => {
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current) =>
        upsertCachedChannel(current, createdChannel),
      );
    },
    onSettled: () => {
      // refetchType "none": onSuccess already cached the relay-returned channel;
      // an immediate getChannels() refetch blocked the dialog and could clobber
      // it with a read-after-write-lagged snapshot. Live updates reconcile later.
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKey,
        refetchType: "none",
      });
    },
  });
}

export function useOpenDmMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: OpenDmInput) => openDm(input),
    onSuccess: (openedChannel) => {
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current) =>
        upsertCachedChannel(current, openedChannel),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: channelsQueryKey });
    },
  });
}

/**
 * Waits for any active channel-list refresh to settle, then restores a
 * relay-returned channel to the shared cache before a caller depends on it for
 * navigation.
 */
export function useUpsertCachedChannel() {
  const queryClient = useQueryClient();

  return React.useCallback(
    async (channel: Channel) => {
      await queryClient.refetchQueries({
        queryKey: channelsQueryKey,
        type: "active",
      });
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current) =>
        reconcileRefreshedCachedChannel(current, channel),
      );
    },
    [queryClient],
  );
}

export function useHideDmMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (channelId: string) => hideDm(channelId),
    onMutate: async (channelId) => {
      await queryClient.cancelQueries({ queryKey: channelsQueryKey });
      const previous = queryClient.getQueryData<Channel[]>(channelsQueryKey);
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current = []) =>
        current.filter((channel) => channel.id !== channelId),
      );
      return { previous };
    },
    onError: (_error, _channelId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(channelsQueryKey, context.previous);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: channelsQueryKey });
    },
  });
}

export function useChannelDetailsQuery(
  channelId: string | null,
  enabled = true,
) {
  return useQuery({
    enabled: enabled && channelId !== null,
    queryKey: ["channels", channelId ?? "none", "detail"],
    queryFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      return getChannelDetails(channelId);
    },
    staleTime: 30_000,
  });
}

export function useChannelMembersQuery(
  channelId: string | null,
  enabled = true,
) {
  return useQuery({
    enabled: enabled && channelId !== null,
    queryKey: ["channels", channelId ?? "none", "members"],
    queryFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      return getChannelMembers(channelId);
    },
    staleTime: 30_000,
  });
}

export function useUpdateChannelMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<UpdateChannelInput, "channelId">) => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      return updateChannel({ ...input, channelId });
    },
    onMutate: () => ({ channelId }),
    onSuccess: (updatedChannel) => {
      queryClient.setQueryData<ChannelDetail>(
        channelDetailQueryKey(updatedChannel.id),
        updatedChannel,
      );
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current = []) =>
        sortChannels(
          current.map((channel) =>
            channel.id === updatedChannel.id ? updatedChannel : channel,
          ),
        ),
      );
    },
    onSettled: (_data, _error, _variables, context) => {
      // refetchType "none": onSuccess already cached the relay-returned detail;
      // awaiting the full channel-list refetch kept the edit dialog stuck on
      // "Saving..." (same failure #1360 fixed for create).
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKey,
        refetchType: "none",
      });
      if (context?.channelId) {
        void queryClient.invalidateQueries({
          queryKey: channelDetailQueryKey(context.channelId),
          refetchType: "none",
        });
      }
    },
  });
}

export function useSetChannelTopicMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<SetChannelTopicInput, "channelId">) => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      return setChannelTopic({ ...input, channelId });
    },
    onSettled: () => {
      // fire-and-forget: awaiting the channels-list refetch blocks the dialog
      void invalidateChannelState(queryClient, channelId);
    },
  });
}

export function useSetChannelPurposeMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<SetChannelPurposeInput, "channelId">) => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      return setChannelPurpose({ ...input, channelId });
    },
    onSettled: () => {
      // fire-and-forget: awaiting the channels-list refetch blocks the dialog
      void invalidateChannelState(queryClient, channelId);
    },
  });
}

export function useArchiveChannelMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      await archiveChannel(channelId);
    },
    onSuccess: () => {
      if (!channelId) {
        return;
      }

      setChannelArchivedState(queryClient, channelId, new Date().toISOString());
    },
    onSettled: async () => {
      await invalidateChannelState(queryClient, channelId);
    },
  });
}

export function useUnarchiveChannelMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      await unarchiveChannel(channelId);
    },
    onSuccess: () => {
      if (!channelId) {
        return;
      }

      setChannelArchivedState(queryClient, channelId, null);
    },
    onSettled: async () => {
      await invalidateChannelState(queryClient, channelId);
    },
  });
}

export function useDeleteChannelMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      await deleteChannel(channelId);
    },
    onSuccess: () => {
      if (!channelId) {
        return;
      }

      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current = []) =>
        current.filter((channel) => channel.id !== channelId),
      );
      queryClient.removeQueries({
        queryKey: channelDetailQueryKey(channelId),
      });
      queryClient.removeQueries({
        queryKey: channelMembersQueryKey(channelId),
      });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: channelsQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["managed-agents"] }),
        queryClient.invalidateQueries({ queryKey: ["relay-agents"] }),
      ]);
    },
  });
}

/**
 * Warn about the parts of a rotation that did not land.
 *
 * Neither is fatal, and neither is worth failing a mutation over: the new
 * epoch has already been minted and signed, an admin list that missed the
 * relay is republished by the next rotation, and a member whose wrap failed
 * stays on the old epoch — readable, just not current — until one reaches them.
 */
function reportRotationDelivery(
  channelId: string,
  outcome: Extract<ChannelKeyRotationOutcome, { rotated: true }>,
): void {
  outcome.published.catch((error) => {
    console.warn(
      `[channel-keys] ${channelId}'s rotated admin list did not reach the relay`,
      error,
    );
  });
  for (const skip of outcome.skipped) {
    console.warn(
      `[channel-keys] the rotated key did not reach ${skip.pubkey}: ${skip.reason}`,
    );
  }
}

/**
 * Rotate an encrypted channel's key after someone is removed from it (buzz#18).
 *
 * Awaited, unlike the add-member gift wraps. Removing a member is a rare,
 * deliberate act whose whole point is that the person can no longer read the
 * channel, and that is not true until the new key has reached the survivors
 * and the new epoch is on the wire. A spinner for the length of those writes
 * is the honest rendering of what the user asked for; returning early would
 * report "removed" while the removal had not happened.
 *
 * The roster is re-read after the removal rather than taken from the query
 * cache, which may still list the member being removed — wrapping the new key
 * to them would undo the rotation in the same breath as performing it.
 *
 * An unencrypted channel — every public one, and every private one nobody has
 * keyed — costs nothing here: `hasChannelKey` is a synchronous local lookup
 * and there is no key to rotate, so the removal is only the roster change it
 * has always been.
 */
async function rotateAfterRemoval(
  channelId: string,
  removed: string,
): Promise<void> {
  if (!hasChannelKey(channelId)) return;

  try {
    const remaining = await getChannelMembers(channelId);
    const outcome = await rotateChannelKeyForRemoval({
      channelId,
      removed: [removed],
      remaining: remaining.map((member) => member.pubkey),
    });

    if (!outcome.rotated) {
      console.warn(
        `[channel-keys] ${channelId} was not rotated after removing ${removed}: ${outcome.reason}`,
      );
      return;
    }

    reportRotationDelivery(channelId, outcome);
  } catch (error) {
    // The member is already off the roster; failing the mutation here would
    // report a removal that did happen as one that did not. The channel stays
    // on its old epoch, which is visible in channel settings, and removing
    // anyone else rotates again.
    console.warn(
      `[channel-keys] could not rotate ${channelId} after removing ${removed}`,
      error,
    );
  }
}

/**
 * Rotate an encrypted channel's key when the member who just left was one of
 * its admins (buzz#42).
 *
 * Leaving is a roster change like removal, but nobody else is there to act on
 * it — the member walking out is the only actor in the picture. Reuses #18's
 * removal machinery with the leaving admin as the sole `removed` pubkey, which
 * is what makes this self-initiated: an admin rotates themselves out on the
 * way out, the same way they could rotate anyone else out — and is denied the
 * new epoch on the same terms, because `rotateChannelKeyForRemoval` skips its
 * final adopt step whenever this client's own pubkey is one of the `removed`.
 * The leaver ends up where a removed member ends up: holding the epochs they
 * were in, holding nothing that opens what the channel says after them.
 *
 * A non-admin leaving changes nothing: they were never entitled to hand this
 * channel's key to anyone, so `rotateChannelKeyForRemoval` refuses at its
 * admin check — after the roster read, but before a key is minted or a write
 * is paid for. The creator is the one admin the admin-list builder will not
 * drop (buzz#18); a creator who leaves still rotates the key like anyone else,
 * with their name staying on the list — re-rooting a channel to a new creator
 * is a separate, unbuilt feature.
 */
async function rotateAfterVoluntaryLeave(channelId: string): Promise<void> {
  if (!hasChannelKey(channelId)) return;

  try {
    const identity = await getIdentity();
    const remaining = await getChannelMembers(channelId);
    const outcome = await rotateChannelKeyForRemoval({
      channelId,
      removed: [identity.pubkey],
      remaining: remaining.map((member) => member.pubkey),
    });

    if (!outcome.rotated) {
      console.warn(
        `[channel-keys] ${channelId} was not rotated after ${identity.pubkey} left: ${outcome.reason}`,
      );
      return;
    }

    reportRotationDelivery(channelId, outcome);
  } catch (error) {
    // The member has already left; failing the mutation here would report a
    // leave that did happen as one that did not. The channel stays on its old
    // epoch, visible in channel settings, and "Rotate now" or the next
    // removal/leave rotates it.
    console.warn(
      `[channel-keys] could not rotate ${channelId} after leaving`,
      error,
    );
  }
}

const ROTATION_REFUSAL_MESSAGES: Record<ChannelKeyRotationRefusal, string> = {
  "channel-not-encrypted": "This channel has no key to rotate.",
  "no-admin-list": "This channel has no signed admin list yet.",
  "not-an-admin": "Only a channel admin can rotate its key.",
};

/**
 * Rotate an encrypted channel's key on demand, without removing anyone
 * (buzz#42).
 *
 * The "this key may have leaked" trigger: reuses #18's removal machinery with
 * an empty `removed` set, so every current member other than the calling
 * admin is re-wrapped a fresh key before the admin list names its epoch —
 * same publish order, same all-or-nothing-per-recipient delivery, just no
 * roster change riding along with it.
 */
export function useRotateChannelKeyMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      const members = await getChannelMembers(channelId);
      const outcome = await rotateChannelKeyForRemoval({
        channelId,
        removed: [],
        remaining: members.map((member) => member.pubkey),
      });

      if (!outcome.rotated) {
        throw new Error(ROTATION_REFUSAL_MESSAGES[outcome.reason]);
      }

      reportRotationDelivery(channelId, outcome);
      return outcome;
    },
    onSettled: async () => {
      await invalidateChannelState(queryClient, channelId);
    },
  });
}

export function useAddChannelMembersMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: Omit<AddChannelMembersInput, "channelId"> & {
        channelId?: string;
      },
    ) => {
      const { channelId: capturedChannelId, ...rest } = input;
      const effectiveChannelId = capturedChannelId ?? channelId;
      if (!effectiveChannelId) {
        throw new Error("No channel selected.");
      }

      const result = await addChannelMembers({
        ...rest,
        channelId: effectiveChannelId,
      });

      // Adding someone to an encrypted channel is handing them the key
      // (buzz#16) — membership IS key possession, so the roster row without
      // the key is a member who sees ciphertext. Only the pubkeys the relay
      // actually accepted.
      //
      // Not awaited: this is one paid write per recipient, and the roster
      // change the user asked for has already succeeded. Holding the dialog
      // open behind N network round trips would make adding five people feel
      // like a failure, and a wrap that never lands is recoverable by
      // re-adding or by the manual key field.
      void grantChannelKeyToMembers(effectiveChannelId, result.added)
        .then((outcome) => {
          for (const skip of outcome.skipped) {
            console.warn(
              `[channel-keys] no key sent to ${skip.pubkey}: ${skip.reason}`,
            );
          }
        })
        .catch((error) => {
          console.warn(
            "[channel-keys] could not deliver the channel key",
            error,
          );
        });

      return result;
    },
    onSettled: async (_data, _err, variables) => {
      // Invalidate the effective channel (the one actually mutated) not the
      // live hook-closure channel, which may have changed mid-send.
      const effectiveChannelId = variables?.channelId ?? channelId;
      await invalidateChannelState(queryClient, effectiveChannelId);
    },
  });
}

export function useRemoveChannelMemberMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (pubkey: string) => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      await removeChannelMember(channelId, pubkey);
      await rotateAfterRemoval(channelId, pubkey);
    },
    onSettled: async () => {
      await Promise.all([
        invalidateChannelState(queryClient, channelId),
        queryClient.invalidateQueries({ queryKey: ["managed-agents"] }),
        queryClient.invalidateQueries({ queryKey: ["relay-agents"] }),
      ]);
    },
  });
}

export function useJoinChannelMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      await joinChannel(channelId);
    },
    onSettled: async () => {
      await invalidateChannelState(queryClient, channelId);
    },
  });
}

export function useLeaveChannelMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!channelId) {
        throw new Error("No channel selected.");
      }

      await leaveChannel(channelId);
      await rotateAfterVoluntaryLeave(channelId);
    },
    onSettled: async () => {
      await invalidateChannelState(queryClient, channelId);
    },
  });
}

export function useSelectedChannel(
  channels: Channel[],
  preferredChannelId: string | null,
) {
  const [selectedChannelId, setSelectedChannelId] = React.useState<
    string | null
  >(preferredChannelId);

  const selectedChannel = React.useMemo(
    () =>
      channels.find((channel) => channel.id === selectedChannelId) ??
      channels.find((channel) => channel.channelType !== "forum") ??
      channels[0] ??
      null,
    [channels, selectedChannelId],
  );

  React.useEffect(() => {
    if (!selectedChannel && channels.length === 0) {
      return;
    }

    if (!selectedChannelId && selectedChannel) {
      setSelectedChannelId(selectedChannel.id);
      return;
    }

    if (
      selectedChannelId &&
      !channels.some((channel) => channel.id === selectedChannelId) &&
      selectedChannel
    ) {
      setSelectedChannelId(selectedChannel.id);
    }
  }, [channels, selectedChannel, selectedChannelId]);

  return {
    selectedChannel,
    selectedChannelId,
    setSelectedChannelId,
  };
}

// ── Canvas ────────────────────────────────────────────────────────────────────
export function useCanvasQuery(channelId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["channel-canvas", channelId],
    queryFn: () => {
      if (!channelId) {
        return Promise.reject(new Error("No channel selected"));
      }
      return getCanvas(channelId);
    },
    enabled: enabled && channelId !== null,
  });
}

export function useSetCanvasMutation(channelId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (content: string) => {
      if (!channelId) {
        return Promise.reject(new Error("No channel selected"));
      }
      return setCanvas({ channelId, content });
    },
    onSuccess: () => {
      if (channelId) {
        void queryClient.invalidateQueries({
          queryKey: ["channel-canvas", channelId],
        });
      }
    },
  });
}
