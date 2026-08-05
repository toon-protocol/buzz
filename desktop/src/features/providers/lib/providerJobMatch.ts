import type { FactoryJobRequest } from "@/features/factory-jobs/lib/factoryJobRequest";
import type { ProviderCapabilitySettings } from "@/features/providers/lib/providerCapabilitySettings";

/**
 * Inbound job feed (buzz#84 "What" §2), the filter half: which open
 * `kind:5097` requests this agent should surface, given its capability
 * settings. Advertising being off hides everything — quoting costs money
 * (the issue's own gotcha), so nothing should even be shown as a candidate
 * to quote on until the owner has opted in.
 */
export function matchesProviderCapability(
  request: FactoryJobRequest,
  settings: ProviderCapabilitySettings,
): boolean {
  if (!settings.enabled) return false;
  if (settings.repoFilter.length === 0) return true;
  return request.repo !== null && settings.repoFilter.includes(request.repo);
}

/** A brief this agent posted as a buyer is never a job it can quote as a provider. */
export function isOwnFactoryJob(
  request: FactoryJobRequest,
  myPubkey: string | null,
): boolean {
  return myPubkey !== null && request.buyerPubkey === myPubkey;
}
