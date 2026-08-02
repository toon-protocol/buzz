import type {
  SearchHit,
  SearchMessagesInput,
  SearchMessagesResponse,
} from "@/shared/api/searchTypes";

/**
 * The TOON-mode search client: ask the search indexer agent-member (buzz#20).
 *
 * ## Why the agent and not the relay
 *
 * On the TOON transport the relay is a public NIP-01 relay that stores
 * ciphertext (ADR 0001). It cannot index what it cannot read, so server-side
 * search is not merely unavailable — it is impossible by design. The only
 * party that can search a private channel is a party that holds its key, and
 * the search agent is exactly that: a member, admitted through the standard
 * gift-wrap flow, that indexes what its key ring opens.
 *
 * ## The scope argument is the membership claim
 *
 * The agent answers only for channels the caller names, and it cannot verify
 * that claim — see the trust-gap note in
 * `crates/buzz-cli/src/search_agent/server.rs`. This module's contract is the
 * client half of that: **only pass channel ids this client holds keys for.**
 * `searchViaAgent` therefore takes the scope explicitly rather than reading it
 * from a store, so a caller cannot widen it by forgetting an argument, and an
 * empty scope short-circuits here rather than travelling to the agent.
 */

/** How long to wait before giving up on a local process. */
const REQUEST_TIMEOUT_MS = 5_000;

type RawAgentHit = {
  eventId?: unknown;
  content?: unknown;
  kind?: unknown;
  pubkey?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  createdAt?: unknown;
  score?: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Shape-check one agent hit into a `SearchHit`, or drop it.
 *
 * Dropping rather than throwing: the agent is a separate binary that can be a
 * version ahead or behind, and one unparseable row should cost that row, not
 * the whole result set.
 */
export function parseAgentHit(raw: RawAgentHit): SearchHit | null {
  const eventId = asString(raw.eventId);
  const pubkey = asString(raw.pubkey);
  const createdAt = asNumber(raw.createdAt);
  if (eventId === null || pubkey === null || createdAt === null) return null;

  return {
    eventId,
    content: typeof raw.content === "string" ? raw.content : "",
    kind: asNumber(raw.kind) ?? 9,
    pubkey,
    channelId: asString(raw.channelId),
    channelName: asString(raw.channelName),
    createdAt,
    score: asNumber(raw.score) ?? 0,
  };
}

/** Parse a whole agent response, dropping rows that do not shape-check. */
export function parseAgentResponse(body: unknown): SearchMessagesResponse {
  const rows =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { hits?: unknown }).hits)
      ? ((body as { hits: RawAgentHit[] }).hits ?? [])
      : [];
  const hits = rows
    .map(parseAgentHit)
    .filter((hit): hit is SearchHit => hit !== null);
  return { hits, found: hits.length };
}

/**
 * Build the agent's query URL.
 *
 * Exported for the test: getting `channels` wrong is the one mistake here that
 * fails open rather than closed, because an agent that receives no scope
 * returns nothing — which reads as "no results" and not as a bug.
 */
export function buildAgentSearchUrl(
  baseUrl: string,
  input: SearchMessagesInput,
  channelIds: readonly string[],
): string {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", input.q);
  url.searchParams.set("channels", channelIds.join(","));
  url.searchParams.set("limit", String(input.limit ?? 20));
  return url.toString();
}

/**
 * Search the agent for `input`, scoped to `channelIds`.
 *
 * `input.channelId` (the `in:` operator) narrows the scope further; it can only
 * ever narrow, never widen, because the intersection is taken here rather than
 * being sent as a separate parameter the agent would have to reconcile.
 */
export async function searchViaAgent(
  baseUrl: string,
  input: SearchMessagesInput,
  channelIds: readonly string[],
): Promise<SearchMessagesResponse> {
  const scope =
    input.channelId === undefined
      ? channelIds
      : channelIds.filter((id) => id === input.channelId);
  if (scope.length === 0 || input.q.trim().length === 0) {
    return { hits: [], found: 0 };
  }

  const response = await fetch(buildAgentSearchUrl(baseUrl, input, scope), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `the search agent at ${baseUrl} returned ${response.status} ${response.statusText}`,
    );
  }
  return parseAgentResponse(await response.json());
}
