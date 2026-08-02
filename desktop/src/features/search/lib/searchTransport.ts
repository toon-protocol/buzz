import { encryptedChannelIds } from "@/shared/api/channelKeyStore";
import type {
  SearchMessagesInput,
  SearchMessagesResponse,
} from "@/shared/api/searchTypes";
import { searchMessages } from "@/shared/api/tauri";
import { getActiveTransportSelection } from "@/shared/api/transportSelection";

import { searchViaAgent } from "./searchAgentClient";

/**
 * The one place search branches on transport (buzz#20, seam split buzz#9).
 *
 * Copied in shape from `shared/api/channelWindow.ts`'s
 * `getChannelWindowPage`: a single facade returning a transport-neutral type,
 * exactly one branch, and both sides producing the identical result so no
 * caller downstream has to know which transport it is on.
 *
 * **Relay mode is untouched.** On the relay transport, search is the
 * Postgres-FTS path it has always been — `invoke("search_messages")` into
 * `buzz-relay`'s `/query`. Nothing about this module runs there.
 *
 * On the TOON transport that path does not exist: the relay stores ciphertext
 * and cannot index it (ADR 0001). Search moves to the search indexer
 * agent-member, which is a member of the channels it indexes, and is reached
 * over its loopback endpoint at `BUZZ_SEARCH_AGENT_URL`.
 */

/**
 * The configured agent URL, or `null` when search should stay on the relay
 * path.
 *
 * Both conditions are required, and the mode check is not redundant: a
 * developer who has `BUZZ_SEARCH_AGENT_URL` exported from an earlier TOON
 * session and then runs in relay mode must get relay search, not a silently
 * different engine.
 */
export function activeSearchAgentUrl(): string | null {
  const selection = getActiveTransportSelection();
  if (selection === null || selection.mode !== "toon") return null;
  return selection.config.searchAgentUrl;
}

/**
 * Search over whichever transport is active.
 *
 * The scope handed to the agent is `encryptedChannelIds()` — the channels this
 * client holds keys for. That is the desktop half of the agent's membership
 * contract (see `searchAgentClient.ts`): the agent serves what it is asked
 * for, so the asking must be honest.
 *
 * Public (unencrypted) channels are deliberately out of scope on TOON for now.
 * The agent only indexes channels it was wrapped a key for, so asking it about
 * a public channel would return nothing anyway; making that explicit here
 * keeps the two membership sets aligned rather than quietly divergent. Public
 * channel search on TOON is the follow-up filed on the PR.
 */
export async function searchMessagesForTransport(
  input: SearchMessagesInput,
): Promise<SearchMessagesResponse> {
  const agentUrl = activeSearchAgentUrl();
  if (agentUrl === null) return searchMessages(input);
  return searchViaAgent(agentUrl, input, encryptedChannelIds());
}
