import type { BrowserAuditStore } from './browser-audit-store';
import { matchesBrowserComputerTarget, type BrowserComputerTargetResolution } from './browser-computer-target';
import { browserExtensionQueueKeyForNode, type BrowserExtensionCommandStore } from './browser-extension-command-store';
import type { BrowserExtensionTabStore } from './browser-extension-tab-store';
import { tryParseWebUrl } from './browser-gateway-service-helpers';
import type { BrowserGatewayFindOrOpenRequest } from './browser-gateway-service-types';
import { CHROME_PROFILE_HISTORY_WINDOW_MS, chooseChromeProfile, type ChromeProfileChoiceResult } from './browser-chrome-profile-choice';

/**
 * How recently an extension must have re-reported a tab for `find_or_open` to
 * treat it as live.
 *
 * This deliberately does NOT mean "re-reported during the refresh we just
 * asked for". An extension relay re-reports each tab on a rolling sweep — a
 * measured 20–55s per tab on a 22-tab remote node — while the refresh command
 * itself is bounded at 2.5–3s. Requiring confirmation inside the refresh
 * window therefore rejected roughly nine live tabs in ten (LT-216): with no
 * URL the agent got `existing_tab_not_confirmed_after_inventory_refresh`, and
 * with a URL it silently opened a duplicate tab instead of reusing the
 * logged-in one.
 *
 * The horizon must exceed the observed sweep period while still excluding
 * genuinely dead inventory (ghost tabs from an ended browser session, which
 * are hours old).
 */
export const EXISTING_TAB_CONFIRMATION_HORIZON_MS = 120_000;

interface ChromeProfileSelectionDeps {
  extensionCommandStore: Partial<Pick<BrowserExtensionCommandStore, 'listRecentExtensionInstances'>>;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'listTabs'>;
  chromeProfileUsage: Pick<BrowserAuditStore, 'countChromeProfileUse'>;
}

/** Choose among the profiles that can currently accept commands on this computer. */
export function chooseChromeProfileForRequest(
  request: BrowserGatewayFindOrOpenRequest,
  target: BrowserComputerTargetResolution,
  url: string | undefined,
  deps: ChromeProfileSelectionDeps,
): ChromeProfileChoiceResult {
  const queueKey = target.nodeId ? browserExtensionQueueKeyForNode(target.nodeId) : 'local';
  const origin = url ? tryParseWebUrl(url)?.origin : undefined;
  const requested = request.chromeProfile?.trim();
  return chooseChromeProfile({
    connected: deps.extensionCommandStore.listRecentExtensionInstances?.(queueKey, true) ?? [],
    usage: deps.chromeProfileUsage.countChromeProfileUse({
      ...(target.nodeId ? { nodeId: target.nodeId } : {}),
      ...(origin ? { origin } : {}),
      since: Date.now() - CHROME_PROFILE_HISTORY_WINDOW_MS,
    }),
    siteProfiles: origin ? deps.extensionTabStore.listTabs()
      .filter((tab) => matchesBrowserComputerTarget(tab, target)
        && tab.origin === origin && tab.suspendedAt === undefined
        && tab.updatedAt >= Date.now() - EXISTING_TAB_CONFIRMATION_HORIZON_MS)
      .flatMap((tab) => tab.extensionInstanceId ? [tab.extensionInstanceId] : []) : [],
    ...(requested ? { requested } : {}),
  });
}
