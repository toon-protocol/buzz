import { signRelayEvent } from "@/shared/api/tauri";

/**
 * NIP-98 HTTP Auth headers (kind:27235) for the desktop's signed HTTP calls.
 *
 * Every verifier the desktop talks to — the relay's bridge/moderation/invite
 * endpoints and the search agent's loopback query endpoint — checks the signed
 * `u` tag against the exact request URL (query string included) and, for a
 * signed body, a `payload` tag carrying its sha256. So both are finalized by
 * the caller *before* signing and neither builder here appends anything
 * afterwards: what is signed and what is sent can never disagree.
 *
 * The web client's `shared/lib/nip98.ts` is the same helper for the browser
 * signer; this one signs through Tauri.
 */

const NIP98_KIND = 27235;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function nip98Header(
  method: string,
  url: string,
  body?: string,
): Promise<string> {
  const tags = [
    ["u", url],
    ["method", method],
  ];
  if (body !== undefined) {
    tags.push(["payload", await sha256Hex(body)]);
  }
  tags.push(["nonce", crypto.randomUUID()]);
  const authEvent = await signRelayEvent({
    kind: NIP98_KIND,
    content: "",
    tags,
  });
  // NIP-98 events carry empty content and ASCII-only tags, so btoa is safe here.
  return `Nostr ${btoa(JSON.stringify(authEvent))}`;
}

/** Build the NIP-98 `Authorization` header for a GET of `url`. */
export function nip98GetHeader(url: string): Promise<string> {
  return nip98Header("GET", url);
}

/**
 * Build the NIP-98 `Authorization` header for a POST of `body` to `url`.
 *
 * The `payload` tag is required by every relay endpoint that takes a signed
 * body (`api/invites.rs` passes `require_payload: true`) and is what stops a
 * body being swapped after signing.
 */
export function nip98PostHeader(url: string, body: string): Promise<string> {
  return nip98Header("POST", url, body);
}
