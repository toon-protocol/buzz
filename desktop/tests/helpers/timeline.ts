import { expect, type Page } from "@playwright/test";

/**
 * Wait for the channel timeline's deferred render to settle.
 *
 * The channel timeline renders off a `useDeferredValue` snapshot that lags
 * the latest `messages` by a commit; the list wrapper carries
 * `data-render-pending="true"` while that commit is in flight and drops the
 * attribute once it settles. Poll for its absence before asserting on
 * freshly-sent content (e.g. avatar mount, thread-summary counts) so the
 * assertion does not race the deferred commit.
 */
export async function waitForTimelineSettled(page: Page): Promise<void> {
  await expect(page.locator("[data-render-pending]")).toHaveCount(0);
}
