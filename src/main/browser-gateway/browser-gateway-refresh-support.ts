import type { BrowserTarget } from '@contracts/types/browser';
import type { BrowserExtensionInventoryRefreshOutcome } from './browser-extension-inventory-refresh';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import { remoteExtensionContactSummary } from './browser-extension-node-contact';
import { refreshBrowserExtensionInventory } from './browser-extension-inventory-refresh';
import type { BrowserExtensionCommandStore } from './browser-extension-command-store';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import { findExistingTabCandidate } from './browser-gateway-target-utils';
import type { BrowserGatewayFindOrOpenRequest } from './browser-gateway-service-types';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { AgentSafeTarget } from './browser-safe-dto';
import { safeTargetFromExistingTab } from './browser-gateway-service-helpers';

/**
 * Support helpers for `listTargets`/`findOrOpen` channel honesty and recovery,
 * extracted from BrowserGatewayService to keep the service within its size
 * ratchet.
 */

export interface InventoryRefreshFailureState {
  failedRefreshNodeIds: Set<string>;
  localRefreshFailed: boolean;
}

export function collectInventoryRefreshFailures(
  outcomes: BrowserExtensionInventoryRefreshOutcome[],
): InventoryRefreshFailureState {
  const failedRefreshNodeIds = new Set<string>();
  let localRefreshFailed = false;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      continue;
    }
    if (outcome.nodeId) {
      failedRefreshNodeIds.add(outcome.nodeId);
    } else {
      localRefreshFailed = true;
    }
  }
  return { failedRefreshNodeIds, localRefreshFailed };
}

/** Mark extension targets whose live refresh failed as stale (cached data). */
export function withRefreshFailureStaleFlag(
  target: BrowserTarget,
  state: InventoryRefreshFailureState,
): BrowserTarget {
  const failed = target.nodeId
    ? state.failedRefreshNodeIds.has(target.nodeId)
    : state.localRefreshFailed;
  return target.driver === 'extension' && failed
    ? { ...target, stale: true, lastConfirmedAt: target.lastConfirmedAt ?? target.lastSeenAt }
    : target;
}

/**
 * Human summary of failed refreshes, or '' when everything refreshed live.
 *
 * The local queue is probed unconditionally, so a machine that simply has no
 * local extension set up would otherwise report "refresh FAILED for the local
 * extension" on every refreshed listing — a false alarm that teaches agents to
 * distrust a channel that was never supposed to exist. Local failures are
 * therefore only reported when local extension targets are actually being
 * served (i.e. there is cached data the failure makes stale). Node failures
 * always report: relay-capable nodes are deliberate setups.
 */
export function describeInventoryRefreshFailures(
  state: InventoryRefreshFailureState,
  extensionContactState: BrowserExtensionContactStateReader,
  targets: ReadonlyArray<{ driver?: string; nodeId?: string }>,
): string {
  const reportLocalFailure = state.localRefreshFailed
    && targets.some((target) => target.driver === 'extension' && !target.nodeId);
  if (state.failedRefreshNodeIds.size === 0 && !reportLocalFailure) {
    return '';
  }
  const parts = [
    ...(reportLocalFailure ? ['the local extension'] : []),
    ...[...state.failedRefreshNodeIds].map((nodeId) =>
      `node ${nodeId} — ${remoteExtensionContactSummary(nodeId, { extensionContactState })}`),
  ];
  return `inventory refresh FAILED for ${parts.join('; ')}; those targets are cached and marked stale`;
}

export function notDeliveredOpenTabMessage(
  nodeId: string | undefined,
  extensionContactState: BrowserExtensionContactStateReader,
): string {
  const channel = nodeId
    ? `node ${nodeId}: ${remoteExtensionContactSummary(nodeId, { extensionContactState })}`
    : 'local extension channel is not polling — is Chrome running with the Harness extension?';
  return `browser_extension_command_not_delivered (${channel}; `
    + 'the open_tab command never reached the extension and did NOT run — safe to retry)';
}

/** Success result for an open_tab whose ack was lost but whose tab was found. */
export function recoveredFindOrOpenResultInput(
  request: BrowserGatewayFindOrOpenRequest,
  recovered: BrowserExistingTabAttachment,
): BrowserGatewayResultInput<AgentSafeTarget> {
  return {
    context: request,
    profileId: recovered.profileId,
    targetId: recovered.targetId,
    action: 'find_or_open',
    toolName: 'browser.find_or_open',
    actionClass: 'navigate',
    decision: 'allowed',
    outcome: 'succeeded',
    summary: 'Opened a new Chrome tab through the Browser Gateway extension '
      + '(the ack timed out, but a post-timeout inventory probe confirmed the tab is open)',
    origin: recovered.origin,
    url: recovered.url,
    data: safeTargetFromExistingTab(recovered),
  };
}

/**
 * Post-timeout recovery: ask the extension to re-report inventory, then look
 * for a tab matching the URL we tried to open. Returns the attachment when the
 * "failed" open actually succeeded (the ack was lost, not the tab).
 */
export async function recoverOpenedTabAfterTimeout(input: {
  nodeId?: string;
  url: string;
  commandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  listTabs: () => BrowserExistingTabAttachment[];
}): Promise<BrowserExistingTabAttachment | null> {
  await refreshBrowserExtensionInventory({
    request: input.nodeId ? { nodeId: input.nodeId } : {},
    commandStore: input.commandStore,
    localOnly: !input.nodeId,
  });
  const tabs = input.listTabs()
    .filter((tab) => !input.nodeId || tab.nodeId === input.nodeId);
  return findExistingTabCandidate(tabs, input.url, undefined);
}
