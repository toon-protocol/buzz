/**
 * The devnet faucet call the wizard's fund step drives directly, rather than
 * through `@toon-protocol/client`'s `fundWallet`.
 *
 * `fundWallet` (toon-meta#258 predates it) throws a flat `NetworkError` on any
 * non-2xx response with no structured status or headers — exactly the two
 * things the fund step needs to tell "wait and retry" (429, cooldown) apart
 * from "something is actually wrong." This module hits the same endpoint
 * (`POST {faucetUrl}/api/base-sepolia/request`, body `{ address }`) but keeps
 * the response status and a parsed `Retry-After` around instead of collapsing
 * them into a message string.
 *
 * Only the EVM leg: Buzz's TOON transport settles on Base Sepolia
 * (`BUZZ_TOON_CHAIN=evm:84532`) and has no Solana or Mina identity to fund.
 *
 * As of toon-meta#258 (fixed and deployed 2026-08-01) this endpoint delivers
 * both the settlement token AND best-effort native gas in one drip. The gas
 * leg is best-effort and its outcome is not parsed from the response body —
 * the shape is faucet-defined and undocumented here. Whether gas actually
 * landed is instead read back from the chain by the caller (a wallet-balance
 * read), which is the only way to know that is not itself faucet-shaped.
 */

const EVM_FAUCET_PATH = "/api/base-sepolia/request";
const DEFAULT_TIMEOUT_MS = 30_000;

export type FaucetDripOutcome =
  | { status: "ok"; response: unknown }
  | {
      status: "cooldown";
      /** Seconds until the next request is allowed, when the header parsed. */
      retryAfterSeconds: number | null;
      message: string;
    }
  | { status: "error"; message: string };

function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Request a devnet drip for `address` on Base Sepolia. Never throws — every
 * outcome the fund step needs to react to (success, 429 cooldown, any other
 * failure) comes back as a tagged result instead, since a wizard step that
 * needs to render a countdown or a "not yet, try later" message from a thrown
 * error would have to string-match it.
 */
export async function requestFaucetDrip(params: {
  faucetUrl: string;
  address: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<FaucetDripOutcome> {
  const { faucetUrl, address } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${faucetUrl.replace(/\/+$/, "")}${EVM_FAUCET_PATH}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      status: "error",
      message: timedOut
        ? `Faucet request timed out after ${timeout}ms (${url})`
        : `Faucet request failed (${url}): ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers.get("Retry-After"),
    );
    return {
      status: "cooldown",
      retryAfterSeconds,
      message:
        retryAfterSeconds !== null
          ? `The faucet already funded this address recently — try again in ${retryAfterSeconds}s.`
          : "The faucet already funded this address recently — try again shortly.",
    };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      status: "error",
      message: `Faucet responded ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
    };
  }

  const body = await response.text().catch(() => "");
  let parsed: unknown = body;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      // Non-JSON 2xx body — still a success, just nothing structured to parse.
    }
  }
  return { status: "ok", response: parsed };
}
