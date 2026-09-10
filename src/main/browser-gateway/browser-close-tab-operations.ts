import type {
  BrowserActionClass,
  BrowserApprovalRequest,
  BrowserGatewayResult,
  BrowserPermissionGrant,
  BrowserTarget,
  BrowserTargetInspectionState,
} from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type {
  BrowserExistingTabAttachment,
  BrowserExtensionTabStore,
} from './browser-extension-tab-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type {
  BrowserGatewayContext,
  BrowserGatewayCloseMatchingRequest,
  BrowserGatewayCloseTabRequest,
} from './browser-gateway-service-types';
import type { BrowserTargetRegistry } from './browser-target-registry';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import {
  matchesBrowserComputerTarget,
  resolveBrowserComputerTarget,
} from './browser-computer-target';
import { existingTabGrantNodeId } from './browser-grant-scope';
import {
  actionClassRequiresAutonomy,
  findMatchingBrowserGrant,
} from './browser-grant-policy';
import { allowedOriginFromUrl } from './browser-gateway-service-helpers';
import { createOrReusePendingBrowserApproval } from './browser-pending-approval-match';
import { isOriginAllowed } from './browser-origin-policy';
import { providerFromContext } from './browser-provider';
import {
  deriveBrowserTargetInspectionState,
} from './browser-target-inspection';

export const CLOSE_TAB_LAST_IN_WINDOW_REASON = 'browser_close_last_tab_in_window_refused';
const CLOSE_MATCHING_MAX = 25;
const CLOSE_MATCHING_DEFAULT = 10;

export interface BrowserCloseTabResult {
  closed: boolean;
  remainingTabCount: number;
  profileId?: string;
  targetId?: string;
  inspectionState?: BrowserTargetInspectionState;
}

export interface BrowserCloseMatchItem {
  profileId: string;
  targetId: string;
  title?: string;
  url?: string;
  inspectionState: BrowserTargetInspectionState;
  reason?: string;
}

export interface BrowserCloseMatchingResult {
  closed: BrowserCloseMatchItem[];
  skipped: BrowserCloseMatchItem[];
  remainingTabCount: number;
  dryRun: boolean;
}

interface CloseCandidate {
  profileId: string;
  targetId: string;
  title?: string;
  url: string;
  origin: string;
  nodeId?: string;
  status: BrowserTarget['status'];
  inspectionState: BrowserTargetInspectionState;
  attachment?: BrowserExistingTabAttachment;
  managed: boolean;
}

interface BrowserCloseTabOperationsDeps {
  targetRegistry: Pick<BrowserTargetRegistry, 'listTargets'>;
  driver: Pick<PuppeteerBrowserDriver, 'closeTarget'>;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab' | 'detachTab' | 'listTabs'>;
  existingTabOperations: Pick<BrowserExistingTabOperations, 'sendCommand'>;
  grantStore: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant'>;
  approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'listRequests'>;
  autoApproveApproval: (approval: BrowserApprovalRequest) => BrowserPermissionGrant | null;
  getWorkerNodes: () => WorkerNodeInfo[];
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

export class BrowserCloseTabOperations {
  constructor(private readonly deps: BrowserCloseTabOperationsDeps) {}

  async closeTab(
    request: BrowserGatewayCloseTabRequest,
  ): Promise<BrowserGatewayResult<BrowserCloseTabResult | null>> {
    const candidate = this.candidateForTarget(request.profileId, request.targetId);
    if (!candidate) {
      return this.denied(request, 'close_tab', 'browser.close_tab', 'target_not_found',
        'Close tab denied because the target was not found', request.profileId, request.targetId);
    }
    const authorized = this.authorize(request, 'close_tab', 'browser.close_tab', candidate);
    if ('result' in authorized) {
      return authorized.result;
    }
    const outcome = await this.executeClose(candidate, request.allowCloseLastInWindow === true);
    if (!outcome.ok) {
      return this.deps.result({
        context: request,
        profileId: candidate.profileId,
        targetId: candidate.targetId,
        action: 'close_tab',
        toolName: 'browser.close_tab',
        actionClass: 'destructive',
        decision: 'allowed',
        outcome: 'failed',
        reason: outcome.reason,
        summary: `Close tab failed: ${outcome.reason}`,
        origin: candidate.origin,
        url: candidate.url,
        grantId: authorized.grant.id,
        autonomous: authorized.grant.autonomous,
        data: null,
      });
    }
    this.consumeIfNeeded(authorized.grant);
    return this.deps.result({
      context: request,
      profileId: candidate.profileId,
      targetId: candidate.targetId,
      action: 'close_tab',
      toolName: 'browser.close_tab',
      actionClass: 'destructive',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Closed browser tab',
      origin: candidate.origin,
      url: candidate.url,
      grantId: authorized.grant.id,
      autonomous: authorized.grant.autonomous,
      data: {
        closed: true,
        remainingTabCount: this.countOpenTargets({ nodeId: candidate.nodeId }),
        profileId: candidate.profileId,
        targetId: candidate.targetId,
        inspectionState: candidate.inspectionState,
      },
    });
  }

  async closeMatching(
    request: BrowserGatewayCloseMatchingRequest,
  ): Promise<BrowserGatewayResult<BrowserCloseMatchingResult | null>> {
    if (!request.urlContains && !request.titleContains && request.status !== 'closed') {
      return this.denied(request, 'close_matching', 'browser.close_matching',
        'close_matching_filter_required',
        'Close matching denied because urlContains, titleContains, or status=closed is required');
    }
    const computerTarget = resolveBrowserComputerTarget(request, {
      connectedNodes: this.deps.getWorkerNodes(),
      descriptors: [
        ...this.deps.targetRegistry.listTargets(request.profileId),
        ...this.deps.extensionTabStore.listTabs(),
      ],
    });
    if (!computerTarget.ok) {
      return this.denied(request, 'close_matching', 'browser.close_matching',
        computerTarget.reason, `Close matching denied: ${computerTarget.reason}`);
    }

    const maxCount = Math.min(CLOSE_MATCHING_MAX, request.maxCount ?? CLOSE_MATCHING_DEFAULT);
    const remainingScope = {
      profileId: request.profileId,
      nodeId: request.nodeId ?? computerTarget.target.nodeId,
    };
    const matches: CloseCandidate[] = [];
    const skipped: BrowserCloseMatchItem[] = [];
    for (const candidate of this.listCandidates(request.profileId)) {
      if (!matchesBrowserComputerTarget(candidate, computerTarget.target)) {
        continue;
      }
      const skip = this.skipReason(candidate, request);
      if (skip) {
        if (this.filterMatches(candidate, request)) {
          skipped.push(this.toMatchItem(candidate, skip));
        }
        continue;
      }
      if (!this.filterMatches(candidate, request)) {
        continue;
      }
      matches.push(candidate);
    }

    const covered: Array<{ candidate: CloseCandidate; grant: BrowserPermissionGrant }> = [];
    for (const candidate of matches) {
      const grant = this.matchingGrant(request, candidate);
      if (!grant) {
        skipped.push(this.toMatchItem(candidate, 'grant_does_not_cover_target'));
        continue;
      }
      covered.push({ candidate, grant });
    }

    const bounded: typeof covered = [];
    for (const entry of covered) {
      if (bounded.length < maxCount) {
        bounded.push(entry);
      } else {
        skipped.push(this.toMatchItem(entry.candidate, 'max_count_reached'));
      }
    }

    if (bounded.length === 0) {
      const firstUnauthorized = matches.find((candidate) => !this.matchingGrant(request, candidate));
      if (!firstUnauthorized) {
        return this.deps.result({
          context: request,
          action: 'close_matching',
          toolName: 'browser.close_matching',
          actionClass: 'destructive',
          decision: 'allowed',
          outcome: 'succeeded',
          summary: 'No matching browser tabs to close',
          data: {
            closed: [],
            skipped,
            remainingTabCount: this.countOpenTargets(remainingScope),
            dryRun: request.dryRun === true,
          },
        });
      }
      const authorized = this.authorize(
        request,
        'close_matching',
        'browser.close_matching',
        firstUnauthorized,
      );
      if ('result' in authorized) {
        return authorized.result;
      }
      for (const candidate of matches) {
        const grant = this.matchingGrant(request, candidate);
        if (!grant) {
          continue;
        }
        const skipIndex = skipped.findIndex((item) => (
          item.targetId === candidate.targetId && item.reason === 'grant_does_not_cover_target'
        ));
        if (skipIndex >= 0) {
          skipped.splice(skipIndex, 1);
        }
        if (bounded.length < maxCount) {
          bounded.push({ candidate, grant });
        } else {
          skipped.push(this.toMatchItem(candidate, 'max_count_reached'));
        }
      }
      if (bounded.length === 0) {
        return this.deps.result({
          context: request,
          action: 'close_matching',
          toolName: 'browser.close_matching',
          actionClass: 'destructive',
          decision: 'allowed',
          outcome: 'succeeded',
          summary: 'No matching browser tabs to close',
          data: {
            closed: [],
            skipped,
            remainingTabCount: this.countOpenTargets(remainingScope),
            dryRun: request.dryRun === true,
          },
        });
      }
    }

    if (request.dryRun === true) {
      return this.deps.result({
        context: request,
        action: 'close_matching',
        toolName: 'browser.close_matching',
        actionClass: 'destructive',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: `Dry-run: would close ${bounded.length} browser tab(s)`,
        grantId: bounded[0]!.grant.id,
        autonomous: bounded[0]!.grant.autonomous,
        data: {
          closed: bounded.map((entry) => this.toMatchItem(entry.candidate)),
          skipped,
          remainingTabCount: this.countOpenTargets(remainingScope),
          dryRun: true,
        },
      });
    }

    const closed: BrowserCloseMatchItem[] = [];
    const usedGrantIds = new Set<string>();
    for (const { candidate, grant } of bounded) {
      const outcome = await this.executeClose(candidate, request.allowCloseLastInWindow === true);
      if (outcome.ok) {
        closed.push(this.toMatchItem(candidate));
        usedGrantIds.add(grant.id);
      } else {
        skipped.push(this.toMatchItem(candidate, outcome.reason));
      }
    }
    for (const grantId of usedGrantIds) {
      const grant = bounded.find((entry) => entry.grant.id === grantId)?.grant;
      if (grant) {
        this.consumeIfNeeded(grant);
      }
    }
    return this.deps.result({
      context: request,
      action: 'close_matching',
      toolName: 'browser.close_matching',
      actionClass: 'destructive',
      decision: 'allowed',
      outcome: closed.length > 0 ? 'succeeded' : 'failed',
      ...(closed.length === 0 ? { reason: skipped[0]?.reason ?? 'close_matching_failed' } : {}),
      summary: closed.length > 0
        ? `Closed ${closed.length} browser tab(s)`
        : 'Close matching failed to close any tab',
      grantId: bounded[0]!.grant.id,
      autonomous: bounded[0]!.grant.autonomous,
      data: {
        closed,
        skipped,
        remainingTabCount: this.countOpenTargets(remainingScope),
        dryRun: false,
      },
    });
  }

  private matchingGrant(
    request: BrowserGatewayContext,
    candidate: CloseCandidate,
  ): BrowserPermissionGrant | null {
    const origin = this.candidateOrigin(candidate);
    const nodeId = existingTabGrantNodeId(candidate.profileId, candidate.nodeId);
    const match = findMatchingBrowserGrant({
      grants: this.deps.grantStore.listGrants({
        instanceId: request.instanceId,
        profileId: candidate.profileId,
        nodeId,
      }),
      instanceId: request.instanceId ?? '',
      provider: providerFromContext(request.provider),
      nodeId,
      profileId: candidate.profileId,
      targetId: candidate.targetId,
      origin,
      liveOrigin: candidate.origin,
      actionClass: 'destructive',
      autonomousRequired: actionClassRequiresAutonomy('destructive'),
    });
    return match.grant ?? null;
  }

  private candidateOrigin(candidate: CloseCandidate): string {
    const originDecision = isOriginAllowed(candidate.url, [
      ...(candidate.attachment?.allowedOrigins ?? []),
      ...(allowedOriginFromUrl(candidate.url) ? [allowedOriginFromUrl(candidate.url)!] : []),
    ]);
    return originDecision.origin ?? candidate.origin;
  }

  private authorize(
    request: BrowserGatewayContext & { requestId?: string },
    action: string,
    toolName: string,
    candidate: CloseCandidate,
  ): { grant: BrowserPermissionGrant } | { result: BrowserGatewayResult<null> } {
    const origin = this.candidateOrigin(candidate);
    const nodeId = existingTabGrantNodeId(candidate.profileId, candidate.nodeId);
    const grant = this.matchingGrant(request, candidate);
    if (grant) {
      return { grant };
    }
    const allowedOrigin = allowedOriginFromUrl(candidate.url);
    if (!allowedOrigin) {
      return {
        result: this.denied(request, action, toolName, 'invalid_url',
          `${toolName} denied because the target URL is invalid`,
          candidate.profileId, candidate.targetId, origin, candidate.url),
      };
    }
    const { approval, reused } = createOrReusePendingBrowserApproval(this.deps.approvalStore, {
      instanceId: request.instanceId ?? 'unknown',
      provider: providerFromContext(request.provider),
      profileId: candidate.profileId,
      targetId: candidate.targetId,
      toolName,
      action,
      actionClass: 'destructive' satisfies BrowserActionClass,
      origin,
      url: candidate.url,
      proposedGrant: {
        mode: 'per_action',
        ...(nodeId ? { nodeId } : {}),
        allowedOrigins: [allowedOrigin],
        allowedActionClasses: ['destructive'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    const autoGrant = this.deps.autoApproveApproval(approval);
    if (autoGrant) {
      return { grant: autoGrant };
    }
    return {
      result: this.deps.result({
        context: request,
        profileId: candidate.profileId,
        targetId: candidate.targetId,
        action,
        toolName,
        actionClass: 'destructive',
        decision: 'requires_user',
        outcome: 'not_run',
        requestId: approval.requestId,
        reason: reused ? 'approval_already_pending' : 'destructive_close_requires_user_approval',
        summary: `${toolName} requires user approval`
          + (candidate.inspectionState !== 'readable'
            ? ` (${candidate.inspectionState}, window ${candidate.attachment?.windowId ?? 'unknown'}`
              + `${candidate.attachment?.tabIndex !== undefined ? `, tab index ${candidate.attachment.tabIndex}` : ''})`
            : ''),
        origin,
        url: candidate.url,
        data: null,
      }),
    };
  }

  private async executeClose(
    candidate: CloseCandidate,
    allowCloseLastInWindow: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (candidate.status === 'closed' && !candidate.attachment) {
      return { ok: true };
    }
    if (candidate.attachment) {
      if (!allowCloseLastInWindow && this.isLastSharedTabInWindow(candidate.attachment)) {
        return { ok: false, reason: CLOSE_TAB_LAST_IN_WINDOW_REASON };
      }
      if (candidate.status !== 'closed') {
        try {
          await this.deps.existingTabOperations.sendCommand(candidate.attachment, 'close_tab', {
            allowCloseLastInWindow,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/not found|no tab|tabs\.remove|missing_extension_tab|Chrome tab/i.test(message)) {
            return { ok: false, reason: message };
          }
        }
      }
      this.deps.extensionTabStore.detachTab(candidate.profileId, candidate.targetId);
      return { ok: true };
    }
    try {
      await this.deps.driver.closeTarget(candidate.profileId, candidate.targetId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private candidateForTarget(profileId: string, targetId: string): CloseCandidate | null {
    const attachment = this.deps.extensionTabStore.getTab(profileId, targetId);
    if (attachment) {
      return this.fromAttachment(attachment);
    }
    const target = this.deps.targetRegistry.listTargets(profileId)
      .find((candidate) => candidate.id === targetId);
    return target ? this.fromRegistryTarget(target) : null;
  }

  private listCandidates(profileId?: string): CloseCandidate[] {
    const seen = new Set<string>();
    const candidates: CloseCandidate[] = [];
    for (const attachment of this.deps.extensionTabStore.listTabs()) {
      if (profileId && attachment.profileId !== profileId) {
        continue;
      }
      seen.add(`${attachment.profileId}:${attachment.targetId}`);
      candidates.push(this.fromAttachment(attachment));
    }
    for (const target of this.deps.targetRegistry.listTargets(profileId)) {
      const key = `${target.profileId ?? ''}:${target.id}`;
      if (seen.has(key)) {
        continue;
      }
      candidates.push(this.fromRegistryTarget(target));
    }
    return candidates;
  }

  private fromAttachment(attachment: BrowserExistingTabAttachment): CloseCandidate {
    return {
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      title: attachment.title,
      url: attachment.url,
      origin: attachment.origin,
      nodeId: attachment.nodeId,
      status: 'selected',
      inspectionState: deriveBrowserTargetInspectionState(attachment),
      attachment,
      managed: false,
    };
  }

  private fromRegistryTarget(target: BrowserTarget): CloseCandidate {
    const attachment = target.profileId
      ? this.deps.extensionTabStore.getTab(target.profileId, target.id)
      : null;
    return {
      profileId: target.profileId ?? '',
      targetId: target.id,
      title: target.title,
      url: target.url ?? target.origin ?? '',
      origin: target.origin ?? '',
      nodeId: target.nodeId,
      status: target.status,
      inspectionState: deriveBrowserTargetInspectionState(target),
      ...(attachment ? { attachment } : {}),
      managed: target.mode !== 'existing-tab',
    };
  }

  private filterMatches(
    candidate: CloseCandidate,
    request: BrowserGatewayCloseMatchingRequest,
  ): boolean {
    if (request.status === 'closed' && candidate.status !== 'closed') {
      return false;
    }
    const url = (candidate.url ?? '').toLowerCase();
    const title = (candidate.title ?? '').toLowerCase();
    if (request.urlContains && !url.includes(request.urlContains.toLowerCase())) {
      return false;
    }
    if (request.titleContains && !title.includes(request.titleContains.toLowerCase())) {
      return false;
    }
    return true;
  }

  private skipReason(
    candidate: CloseCandidate,
    request: BrowserGatewayCloseMatchingRequest,
  ): string | null {
    if (
      candidate.inspectionState === 'inspection_unavailable'
      && request.includeInspectionUnavailable !== true
      && request.status !== 'closed'
    ) {
      return 'inspection_unavailable_skipped';
    }
    if (
      candidate.inspectionState === 'secret_tainted'
      && request.includeSecretTainted !== true
      && request.status !== 'closed'
    ) {
      return 'secret_tainted_skipped';
    }
    return null;
  }

  private isLastSharedTabInWindow(attachment: BrowserExistingTabAttachment): boolean {
    return this.deps.extensionTabStore.listTabs().filter((tab) => (
      tab.windowId === attachment.windowId
      && tab.nodeId === attachment.nodeId
    )).length <= 1;
  }

  private countOpenTargets(request: { profileId?: string; nodeId?: string }): number {
    return this.listCandidates(request.profileId)
      .filter((candidate) => candidate.status !== 'closed')
      .filter((candidate) => !request.nodeId || candidate.nodeId === request.nodeId)
      .length;
  }

  private toMatchItem(candidate: CloseCandidate, reason?: string): BrowserCloseMatchItem {
    return {
      profileId: candidate.profileId,
      targetId: candidate.targetId,
      title: candidate.title,
      url: candidate.url,
      inspectionState: candidate.inspectionState,
      ...(reason ? { reason } : {}),
    };
  }

  private consumeIfNeeded(grant: BrowserPermissionGrant): void {
    if (grant.mode === 'per_action') {
      this.deps.grantStore.consumeGrant(grant.id);
    }
  }

  private denied(
    request: BrowserGatewayContext,
    action: string,
    toolName: string,
    reason: string,
    summary: string,
    profileId?: string,
    targetId?: string,
    origin?: string,
    url?: string,
  ): BrowserGatewayResult<null> {
    return this.deps.result({
      context: request,
      ...(profileId ? { profileId } : {}),
      ...(targetId ? { targetId } : {}),
      action,
      toolName,
      actionClass: 'destructive',
      decision: 'denied',
      outcome: 'not_run',
      reason,
      summary,
      ...(origin ? { origin } : {}),
      ...(url ? { url } : {}),
      data: null,
    });
  }
}
