import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import type { BrowserExtensionCommandStore } from './browser-extension-command-store';
import {
  BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
  browserExtensionQueueKeyForNode,
} from './browser-extension-command-store';
import type {
  BrowserExistingTabAttachment,
  BrowserExtensionTabStore,
} from './browser-extension-tab-store';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import {
  isRemoteExtensionContactFresh,
  remoteExtensionUnreachableFindOrOpenInput,
  withRemoteExtensionStaleFlag,
} from './browser-extension-node-contact';
import { extractTabPayload, safeTargetFromExistingTab } from './browser-gateway-service-helpers';
import {
  findExistingTabCandidate,
} from './browser-gateway-target-utils';
import {
  collectInventoryRefreshFailures,
  describeInventoryRefreshFailures,
  notDeliveredOpenTabMessage,
  recoveredFindOrOpenResultInput,
  recoverOpenedTabAfterTimeout,
  withRefreshFailureStaleFlag,
} from './browser-gateway-refresh-support';
import { refreshBrowserExtensionInventory } from './browser-extension-inventory-refresh';
import type {
  BrowserGatewayFindOrOpenRequest,
  BrowserGatewayListTargetsRequest,
  BrowserGatewayPreflightTargetRequest,
} from './browser-gateway-service-types';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserTargetRegistry } from './browser-target-registry';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import { toAgentSafeTarget, type AgentSafeTarget } from './browser-safe-dto';
import {
  matchesBrowserComputerTarget,
  resolveBrowserComputerTarget,
  type BrowserComputerTargetResolution,
} from './browser-computer-target';
import {
  isLocalExtensionChannelProvablyDown,
  type BrowserLocalExtensionHealth,
} from './browser-local-extension-health';
import {
  selectBrowserTargetForUrl,
  type BrowserTargetPreflightResult,
} from './browser-target-preflight';

interface BrowserTargetDiscoveryDeps {
  /**
   * Live health for the AIO host's own extension channel, so local requests get
   * the same freshness precheck and channel honesty the node path already has.
   */
  localExtensionChannel: () => BrowserLocalExtensionHealth;
  targetRegistry: Pick<BrowserTargetRegistry, 'listTargets'>;
  driver: Pick<PuppeteerBrowserDriver, 'listTargets'>;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'attachTab' | 'listTabs'>;
  extensionCommandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  extensionContactState: BrowserExtensionContactStateReader;
  getWorkerNodes: () => WorkerNodeInfo[];
  getWorkerNode: (nodeId: string) => WorkerNodeInfo | undefined;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

export class BrowserTargetDiscoveryOperations {
  constructor(private readonly deps: BrowserTargetDiscoveryDeps) {}

  async listTargets(
    request: BrowserGatewayListTargetsRequest = {},
  ): Promise<BrowserGatewayResult<AgentSafeTarget[]>> {
    const registryTargets = this.deps.targetRegistry.listTargets(request.profileId);
    const computerTarget = resolveBrowserComputerTarget(request, {
      connectedNodes: this.deps.getWorkerNodes(),
      descriptors: registryTargets,
    });
    if (!computerTarget.ok) {
      return this.deps.result({
        context: request,
        profileId: request.profileId,
        action: 'list_targets',
        toolName: 'browser.list_targets',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: computerTarget.reason,
        summary: `Browser target listing denied: ${computerTarget.reason}`,
        data: [],
      });
    }

    const refreshFailures = collectInventoryRefreshFailures(
      request.refresh === true
        ? await refreshBrowserExtensionInventory({
          request: {
            ...request,
            ...(computerTarget.target.nodeId ? { nodeId: computerTarget.target.nodeId } : {}),
          },
          commandStore: this.deps.extensionCommandStore,
          localOnly: computerTarget.target.localOnly,
        })
        : [],
    );
    const refreshedRegistryTargets = this.deps.targetRegistry.listTargets(request.profileId);
    const liveTargets = request.profileId
      ? await this.deps.driver.listTargets(request.profileId).catch(() => null)
      : null;
    const targets = (liveTargets ?? refreshedRegistryTargets)
      .filter((target) => matchesBrowserComputerTarget(target, computerTarget.target))
      .map((target) => withRemoteExtensionStaleFlag(target, {
        extensionContactState: this.deps.extensionContactState,
      }))
      .map((target) => withRefreshFailureStaleFlag(target, refreshFailures))
      .map((target) => toAgentSafeTarget(target));
    const degradedSummary = [
      describeInventoryRefreshFailures(
        refreshFailures,
        this.deps.extensionContactState,
        targets,
      ),
      this.describeLocalChannelDegradation(computerTarget.target),
    ].filter(Boolean).join('; ');
    return this.deps.result({
      context: request,
      profileId: request.profileId,
      action: 'list_targets',
      toolName: 'browser.list_targets',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Listed ${targets.length} browser targets${degradedSummary ? ` (${degradedSummary})` : ''}`,
      ...(degradedSummary ? { reason: degradedSummary } : {}),
      data: targets,
    });
  }

  /**
   * An empty target list must not read the same whether the local extension is
   * absent, silent, or healthy-with-nothing-shared. Returns a degraded-channel
   * sentence for the first two, and '' for a healthy channel so a legitimate
   * "no tabs shared yet" stays a clean success.
   *
   * Stays quiet about a never-installed local extension unless the caller
   * explicitly asked for the local computer — otherwise every listing on a
   * machine that only uses worker nodes would carry a bogus warning.
   */
  private describeLocalChannelDegradation(
    target: BrowserComputerTargetResolution,
  ): string {
    if (target.nodeId) {
      return '';
    }
    const channel = this.deps.localExtensionChannel();
    // 'unknown' means the probe could not run, not that anything is wrong.
    if (channel.state === 'ready' || channel.state === 'unknown') {
      return '';
    }
    if (!channel.installed && !target.localOnly) {
      return '';
    }
    return `local extension channel is degraded (${channel.state}): ${channel.summary}`
      + `${channel.remediation ? ` ${channel.remediation}` : ''}`;
  }

  /**
   * Pick the best existing logged-in tab for a URL and explain every rejection.
   * Read-only: it never opens, attaches to, or drives anything, so it is safe
   * to run before deciding how to proceed.
   */
  async preflightTarget(
    request: BrowserGatewayPreflightTargetRequest,
  ): Promise<BrowserGatewayResult<BrowserTargetPreflightResult | null>> {
    const url = request.url?.trim();
    if (!url) {
      return this.deps.result({
        context: request,
        action: 'preflight_target',
        toolName: 'browser.preflight_target',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'url_required_for_preflight',
        summary: 'A URL is required to select a Browser Gateway target',
        data: null,
      });
    }
    const computerTarget = resolveBrowserComputerTarget(request, {
      connectedNodes: this.deps.getWorkerNodes(),
      descriptors: this.deps.extensionTabStore.listTabs(),
    });
    if (!computerTarget.ok) {
      return this.deps.result({
        context: request,
        action: 'preflight_target',
        toolName: 'browser.preflight_target',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: computerTarget.reason,
        summary: `Browser target preflight denied: ${computerTarget.reason}`,
        url,
        data: null,
      });
    }

    const targets = this.deps.targetRegistry.listTargets()
      .map((target) => withRemoteExtensionStaleFlag(target, {
        extensionContactState: this.deps.extensionContactState,
      }));
    const preflight = selectBrowserTargetForUrl({
      url,
      targets,
      requestedComputer: computerTarget.target,
    });
    const channelNote = this.describeLocalChannelDegradation(computerTarget.target);
    return this.deps.result({
      context: request,
      ...(preflight.selected?.profileId ? { profileId: preflight.selected.profileId } : {}),
      ...(preflight.selected ? { targetId: preflight.selected.targetId } : {}),
      action: 'preflight_target',
      toolName: 'browser.preflight_target',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: preflight.summary,
      ...(channelNote ? { reason: channelNote } : {}),
      url,
      data: preflight,
    });
  }

  async findOrOpen(
    request: BrowserGatewayFindOrOpenRequest,
  ): Promise<BrowserGatewayResult<AgentSafeTarget | null>> {
    const url = request.url?.trim();
    const titleHint = request.titleHint?.trim().toLowerCase();
    const initialTabs = this.deps.extensionTabStore.listTabs();
    const computerTarget = resolveBrowserComputerTarget(request, {
      connectedNodes: this.deps.getWorkerNodes(),
      descriptors: initialTabs,
    });
    if (!computerTarget.ok) {
      return this.deps.result({
        context: request,
        action: 'find_or_open',
        toolName: 'browser.find_or_open',
        actionClass: url ? 'navigate' : 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: computerTarget.reason,
        summary: `Browser target lookup denied: ${computerTarget.reason}`,
        ...(url ? { url } : {}),
        data: null,
      });
    }

    const tabs = initialTabs.filter((tab) => matchesBrowserComputerTarget(tab, computerTarget.target));
    let existing = findExistingTabCandidate(tabs, url, titleHint);
    if (existing) {
      const staleResult = this.remoteStaleResult(request, existing);
      if (staleResult) {
        return staleResult;
      }
      const confirmed = await this.confirmExistingCandidate(request, computerTarget.target, url, titleHint);
      if (confirmed) {
        existing = confirmed;
      } else if (!url) {
        return this.cachedTabNotConfirmed(request, existing);
      } else {
        existing = null;
      }
    }
    if (existing) {
      return this.deps.result({
        context: request,
        profileId: existing.profileId,
        targetId: existing.targetId,
        action: 'find_or_open',
        toolName: 'browser.find_or_open',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Selected an existing Chrome tab matching the browser task',
        origin: existing.origin,
        url: existing.url,
        data: safeTargetFromExistingTab(existing),
      });
    }

    return this.openTab(request, computerTarget.target, url);
  }

  private remoteStaleResult(
    request: BrowserGatewayFindOrOpenRequest,
    existing: BrowserExistingTabAttachment,
  ): BrowserGatewayResult<AgentSafeTarget | null> | null {
    if (
      !existing.nodeId ||
      isRemoteExtensionContactFresh(existing.nodeId, { extensionContactState: this.deps.extensionContactState })
    ) {
      return null;
    }
    return this.deps.result(remoteExtensionUnreachableFindOrOpenInput({
      request,
      profileId: existing.profileId,
      targetId: existing.targetId,
      actionClass: 'read',
      url: existing.url,
      origin: existing.origin,
      nodeId: existing.nodeId,
      deps: { extensionContactState: this.deps.extensionContactState },
    }));
  }

  private async confirmExistingCandidate(
    request: BrowserGatewayFindOrOpenRequest,
    target: BrowserComputerTargetResolution,
    url: string | undefined,
    titleHint: string | undefined,
  ): Promise<BrowserExistingTabAttachment | null> {
    if (!target.nodeId && !target.localOnly) {
      return findExistingTabCandidate(
        this.deps.extensionTabStore.listTabs().filter((tab) => matchesBrowserComputerTarget(tab, target)),
        url,
        titleHint,
      );
    }
    // A provably-down local channel cannot confirm anything; refreshing would
    // just burn the 90s undelivered-wait before reaching the same conclusion.
    if (target.localOnly && isLocalExtensionChannelProvablyDown(this.deps.localExtensionChannel())) {
      return null;
    }
    const refreshStartedAt = Date.now();
    const failures = collectInventoryRefreshFailures(await refreshBrowserExtensionInventory({
      request: target.nodeId ? { ...request, nodeId: target.nodeId } : request,
      commandStore: this.deps.extensionCommandStore,
      localOnly: target.localOnly,
    }));
    if (target.nodeId && failures.failedRefreshNodeIds.has(target.nodeId)) {
      return null;
    }
    if (target.localOnly && failures.localRefreshFailed) {
      return null;
    }
    const tabs = this.deps.extensionTabStore.listTabs()
      .filter((tab) => matchesBrowserComputerTarget(tab, target));
    return findExistingTabCandidate(tabs, url, titleHint, { minUpdatedAt: refreshStartedAt });
  }

  private cachedTabNotConfirmed(
    request: BrowserGatewayFindOrOpenRequest,
    existing: BrowserExistingTabAttachment,
  ): BrowserGatewayResult<AgentSafeTarget | null> {
    return this.deps.result({
      context: request,
      profileId: existing.profileId,
      targetId: existing.targetId,
      action: 'find_or_open',
      toolName: 'browser.find_or_open',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'failed',
      reason: 'existing_tab_not_confirmed_after_inventory_refresh',
      summary: 'Matching existing Chrome tab was cached, but a fresh inventory refresh did not confirm it',
      origin: existing.origin,
      url: existing.url,
      data: null,
    });
  }

  private async openTab(
    request: BrowserGatewayFindOrOpenRequest,
    target: BrowserComputerTargetResolution,
    url: string | undefined,
  ): Promise<BrowserGatewayResult<AgentSafeTarget | null>> {
    if (!url) {
      return this.deps.result({
        context: request,
        action: 'find_or_open',
        toolName: 'browser.find_or_open',
        actionClass: 'navigate',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'url_required_to_open_tab',
        summary: 'A URL is required before Browser Gateway can open a new Chrome tab',
        data: null,
      });
    }

    if (
      target.nodeId &&
      !isRemoteExtensionContactFresh(target.nodeId, { extensionContactState: this.deps.extensionContactState })
    ) {
      return this.deps.result(remoteExtensionUnreachableFindOrOpenInput({
        request,
        actionClass: 'navigate',
        url,
        nodeId: target.nodeId,
        deps: { extensionContactState: this.deps.extensionContactState },
      }));
    }

    // Local mirror of the node precheck above. Without it a `computer: "local"`
    // open burned the full 90s undelivered-wait against a channel that health
    // already proved has no consumer, then failed with a generic
    // `not_delivered`. Only fires when the channel is PROVABLY down (no
    // registration / broken native-host chain) so a merely silent extension
    // still gets the recovery wait it was designed for.
    const localDownResult = this.localChannelDownResult(request, target, url);
    if (localDownResult) {
      return localDownResult;
    }

    try {
      const result = await this.deps.extensionCommandStore.sendCommand({
        ...(target.nodeId ? { queueKey: browserExtensionQueueKeyForNode(target.nodeId) } : {}),
        command: 'open_tab',
        payload: { url },
        timeoutMs: 30_000,
        undeliveredWaitMs: BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
      });
      const tab = extractTabPayload(result);
      const node = target.nodeId ? this.deps.getWorkerNode(target.nodeId) : undefined;
      const attachment = this.deps.extensionTabStore.attachTab(tab, {
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
        ...(node?.name || target.nodeName ? { nodeName: node?.name ?? target.nodeName } : {}),
      });
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'find_or_open',
        toolName: 'browser.find_or_open',
        actionClass: 'navigate',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Opened a new Chrome tab through the Browser Gateway extension',
        origin: attachment.origin,
        url: attachment.url,
        data: safeTargetFromExistingTab(attachment),
      });
    } catch (error) {
      return this.openTabFailed(request, target, url, error);
    }
  }

  private localChannelDownResult(
    request: BrowserGatewayFindOrOpenRequest,
    target: BrowserComputerTargetResolution,
    url: string,
  ): BrowserGatewayResult<AgentSafeTarget | null> | null {
    if (target.nodeId) {
      return null;
    }
    const channel = this.deps.localExtensionChannel();
    if (!isLocalExtensionChannelProvablyDown(channel)) {
      return null;
    }
    // The agent-facing result carries `reason`, not `summary`, so the exact
    // repair has to live in `reason` — same convention as
    // `notDeliveredOpenTabMessage`.
    const reason = `browser_local_extension_unreachable (${channel.state}: ${channel.summary}`
      + `${channel.remediation ? ` ${channel.remediation}` : ''}`
      + ' The open_tab command was NOT queued and did NOT run — safe to retry once repaired.)';
    return this.deps.result({
      context: request,
      action: 'find_or_open',
      toolName: 'browser.find_or_open',
      actionClass: 'navigate',
      decision: 'allowed',
      outcome: 'failed',
      reason,
      summary: `Local Chrome extension channel is unreachable: ${channel.summary}`,
      url,
      data: null,
    });
  }

  private async openTabFailed(
    request: BrowserGatewayFindOrOpenRequest,
    target: BrowserComputerTargetResolution,
    url: string,
    error: unknown,
  ): Promise<BrowserGatewayResult<AgentSafeTarget | null>> {
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (
      rawMessage.startsWith('browser_extension_command_timeout') ||
      rawMessage.startsWith('browser_extension_command_receipt_missing')
    ) {
      const recovered = await recoverOpenedTabAfterTimeout({
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
        url,
        commandStore: this.deps.extensionCommandStore,
        listTabs: () => this.deps.extensionTabStore.listTabs(),
      });
      if (recovered) {
        return this.deps.result(recoveredFindOrOpenResultInput(request, recovered));
      }
    }
    const message = rawMessage.startsWith('browser_extension_command_not_delivered')
      ? notDeliveredOpenTabMessage(target.nodeId, this.deps.extensionContactState)
      : rawMessage;
    return this.deps.result({
      context: request,
      action: 'find_or_open',
      toolName: 'browser.find_or_open',
      actionClass: 'navigate',
      decision: 'allowed',
      outcome: 'failed',
      reason: message,
      summary: `Chrome extension could not open a tab: ${message}`,
      url,
      data: null,
    });
  }
}
