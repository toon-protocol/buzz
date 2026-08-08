import * as React from "react";

import type { ChannelAdminList } from "@/shared/api/channelAdminList";
import {
  getChannelAdminList,
  subscribeToChannelAdminLists,
} from "@/shared/api/channelAdminListStore";

/**
 * The validated admin list for a channel, re-rendering when a new signed one
 * arrives.
 *
 * Reads the store rather than the relay: `channelAdminListStore` folds every
 * candidate event into the one state this client is willing to believe, so a
 * component that renders from it — or gates an admin-only action on it — is
 * gating on the same authority the key delivery path uses.
 */
export function useChannelAdminList(
  channelId: string,
): ChannelAdminList | null {
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
