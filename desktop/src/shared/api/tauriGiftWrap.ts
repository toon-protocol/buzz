import { invokeTauri } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";

/**
 * NIP-59 gift wrap seal/unseal via Rust (buzz#43).
 *
 * The two NIP-44 layers a gift wrap needs (ECDH to the recipient for the
 * seal, ECDH to the sender for the unwrap) live in Rust so the identity
 * secret key never has to enter the renderer for a channel-key wrap the way
 * it already doesn't for a signature. See `channelKeyDelivery.ts`'s
 * `wrapChannelKeyViaRust`/`unwrapChannelKeyViaRust` for the callers.
 */

/** What `unseal_gift_wrap` returns for a wrap it could open. */
export type UnsealedGift = {
  sender: string;
  kind: number;
  content: string;
  tags: string[][];
  createdAt: number;
};

export async function sealGiftWrap(input: {
  recipient: string;
  kind: number;
  content: string;
  tags: string[][];
}): Promise<RelayEvent> {
  const wrapJson = await invokeTauri<string>("seal_gift_wrap", input);
  return JSON.parse(wrapJson) as RelayEvent;
}

/** `null` for anything that is not a well-formed wrap this identity can open. */
export async function unsealGiftWrap(
  wrap: RelayEvent,
): Promise<UnsealedGift | null> {
  return invokeTauri<UnsealedGift | null>("unseal_gift_wrap", {
    wrapJson: JSON.stringify(wrap),
  });
}
