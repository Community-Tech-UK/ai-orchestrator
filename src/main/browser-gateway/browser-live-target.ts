import type { BrowserTarget } from '@contracts/types/browser';
import type { BrowserTargetRegistry } from './browser-target-registry';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';

export async function refreshRegisteredBrowserTarget(
  registry: Pick<BrowserTargetRegistry, 'listTargets'>,
  driver: Pick<PuppeteerBrowserDriver, 'refreshTarget'>,
  profileId: string,
  targetId: string,
): Promise<{ target: BrowserTarget | null; error?: string }> {
  const target = registry.listTargets(profileId).find((candidate) => candidate.id === targetId);
  if (!target) return { target: null };
  try {
    return { target: await driver.refreshTarget(profileId, targetId) };
  } catch (error) {
    return { target: null, error: error instanceof Error ? error.message : String(error) };
  }
}
