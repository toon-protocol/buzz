import { nip98PostHeader } from "@/shared/api/nip98";
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
 * ## The scope argument is a claim, the signature is the proof (buzz#179)
 *
 * The agent answers only for channels the caller names *and* whose validated
 * `kind:39100` admin list names the signer — see the query-surface docs in
 * `crates/buzz-cli/src/search_agent/server.rs`. This module's contract is the
 * client half of that: **only pass channel ids this client holds keys for**
 * (the claim), and every request is NIP-98-signed with this identity's own
 * key (the proof). `searchViaAgent` takes the scope explicitly rather than
 * reading it from a store, so a caller cannot widen it by forgetting an
 * argument, and an empty scope short-circuits here rather than travelling to
 * the agent.
 *
 * A `POST` carries the query, not a `GET` querystring: the endpoint already
 * accepted a JSON body (`handle_post` in `server.rs`), and a signed request
 * needs a body to hash into the NIP-98 `payload` tag anyway.
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

/** The JSON body shape `handle_post` (`server.rs`) deserializes. */
export type AgentSearchBody = {
  q: string;
  channels: string[];
  limit: number;
  authors?: string[];
  since?: number;
  until?: number;
};

/**
 * Build the agent's query body.
 *
 * Exported for the test: getting `channels` wrong is the one mistake here that
 * fails open rather than closed, because an agent that receives no scope
 * returns nothing — which reads as "no results" and not as a bug.
 * `authors`/`since`/`until` are passed through as-is (`undefined` drops the
 * key on serialization) — the agent already treats an absent filter as "no
 * narrowing".
 */
export function buildAgentSearchBody(
  input: SearchMessagesInput,
  channelIds: readonly string[],
): AgentSearchBody {
  return {
    q: input.q,
    channels: [...channelIds],
    limit: input.limit ?? 20,
    authors: input.authors,
    since: input.since,
    until: input.until,
  };
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

  const url = new URL("/search", baseUrl).toString();
  const body = JSON.stringify(buildAgentSearchBody(input, scope));
  const authorization = await nip98PostHeader(url, body);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `the search agent at ${baseUrl} returned ${response.status} ${response.statusText}`,
    );
  }
  return parseAgentResponse(await response.json());
}
