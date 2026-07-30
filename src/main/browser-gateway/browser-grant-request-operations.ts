import type {
  BrowserApprovalRequest,
  BrowserGatewayResult,
  BrowserPermissionGrant,
  BrowserRequestGrantRequest,
  BrowserTarget,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserExistingTabAttachment, BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserProfileStore } from './browser-profile-store';
import { providerFromContext } from './browser-gateway-action-guard';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import { primaryActionClass } from './browser-gateway-service-helpers';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import { findGrantCoveringProposal, proposalCoversProposal } from './browser-grant-policy';
import { existingTabGrantNodeId } from './browser-grant-scope';
import { isOriginAllowed } from './browser-origin-policy';

/**
 * `browser.request_grant` for managed profiles and shared existing Chrome tabs.
 *
 * Both paths are idempotent: when a live grant already authorizes the whole
 * proposal the tool reports success against that grant instead of recording
 * another approval request. Agents re-ask for permission whenever an unrelated
 * failure looks like a denial (an extension command timeout, most often), and
 * every re-ask used to raise a fresh dialog for a site the user had just
 * approved.
 */
export class BrowserGrantRequestOperations {
  constructor(private readonly deps: {
    extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
    profileStore: Pick<BrowserProfileStore, 'getProfile'>;
    grantStore: Pick<BrowserGrantStore, 'listGrants'>;
    approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'listRequests'>;
    getLiveTarget: (
      profileId: string,
      targetId: string,
    ) => Promise<{ target: BrowserTarget | null; error?: string }>;
    autoApproveApproval?: (approval: BrowserApprovalRequest) => BrowserPermissionGrant | null;
    result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  }) {}

  async requestGrant(
    request: BrowserGatewayContext & BrowserRequestGrantRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const existingTab = this.deps.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return this.requestGrantForExistingTab(request, existingTab);
    }

    const profile = this.deps.profileStore.getProfile(request.profileId);
    const { target, error } = profile
      ? await this.deps.getLiveTarget(request.profileId, request.targetId)
      : { target: null, error: undefined };
    const currentUrl = target?.url;
    if (!profile || !target || !currentUrl) {
      return this.deps.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'request_grant',
        toolName: 'browser.request_grant',
        actionClass: 'unknown',
        decision: 'denied',
        outcome: 'not_run',
        reason: error ?? 'profile_target_or_url_not_found',
        summary: error
          ? `Browser grant request denied because the live browser target could not be refreshed: ${error}`
          : 'Browser grant request denied because the profile, target, or URL was not found',
        data: null,
      });
    }

    const originDecision = isOriginAllowed(currentUrl, profile.allowedOrigins);
    if (!originDecision.allowed) {
      return this.deps.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'request_grant',
        toolName: 'browser.request_grant',
        actionClass: 'unknown',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Browser grant request denied by origin policy: ${originDecision.reason}`,
        origin: target.origin,
        url: currentUrl,
        data: null,
      });
    }

    const actionClass = primaryActionClass(request.proposedGrant.allowedActionClasses);
    const covering = findGrantCoveringProposal({
      grants: this.deps.grantStore.listGrants({
        instanceId: request.instanceId,
        profileId: profile.id,
      }),
      instanceId: request.instanceId ?? '',
      provider: providerFromContext(request.provider),
      profileId: profile.id,
      targetId: target.id,
      origin: originDecision.origin,
      proposal: request.proposedGrant,
    });
    if (covering) {
      return this.alreadyGrantedResult(request, {
        profileId: profile.id,
        targetId: target.id,
        actionClass,
        origin: originDecision.origin,
        url: currentUrl,
        grant: covering,
      });
    }

    const waiting = this.findPendingRequest(request, profile.id, target.id);
    if (waiting) {
      return this.stillWaitingResult(request, {
        profileId: profile.id,
        targetId: target.id,
        actionClass,
        origin: originDecision.origin,
        url: currentUrl,
        requestId: waiting.requestId,
      });
    }

    const approval = this.deps.approvalStore.createRequest({
      instanceId: request.instanceId ?? 'unknown',
      provider: providerFromContext(request.provider),
      profileId: profile.id,
      targetId: target.id,
      toolName: 'browser.request_grant',
      action: 'request_grant',
      actionClass,
      origin: originDecision.origin,
      url: currentUrl,
      proposedGrant: request.proposedGrant,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    const autoGrant = this.deps.autoApproveApproval?.(approval) ?? null;
    if (autoGrant) {
      return this.deps.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'request_grant',
        toolName: 'browser.request_grant',
        actionClass,
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Auto-approved Browser Gateway grant request',
        origin: originDecision.origin,
        url: currentUrl,
        grantId: autoGrant.id,
        autonomous: autoGrant.autonomous,
        data: null,
      });
    }

    return this.deps.result({
      context: request,
      profileId: profile.id,
      targetId: target.id,
      action: 'request_grant',
      toolName: 'browser.request_grant',
      actionClass,
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: approval.requestId,
      reason: request.reason ?? 'browser_grant_requires_user_approval',
      summary: 'Browser grant request requires user approval',
      origin: originDecision.origin,
      url: currentUrl,
      data: null,
    });
  }

  private async requestGrantForExistingTab(
    request: BrowserGatewayContext & BrowserRequestGrantRequest,
    attachment: BrowserExistingTabAttachment,
  ): Promise<BrowserGatewayResult<null>> {
    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'request_grant',
        toolName: 'browser.request_grant',
        actionClass: 'unknown',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Browser grant request denied by existing Chrome tab origin policy: ${originDecision.reason}`,
        origin: originDecision.origin,
        url: attachment.url,
        data: null,
      });
    }

    const actionClass = primaryActionClass(request.proposedGrant.allowedActionClasses);
    // Existing-tab grants are node-scoped (profileId omitted, nodeId set)
    // because the tab's own profileId is per-attachment — see
    // browser-grant-scope.ts.
    const nodeId = existingTabGrantNodeId(attachment.profileId, attachment.nodeId);
    const covering = findGrantCoveringProposal({
      grants: this.deps.grantStore.listGrants({
        instanceId: request.instanceId,
        profileId: attachment.profileId,
        ...(nodeId ? { nodeId } : {}),
      }),
      instanceId: request.instanceId ?? '',
      provider: providerFromContext(request.provider),
      ...(nodeId ? { nodeId } : {}),
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      origin: originDecision.origin,
      proposal: request.proposedGrant,
    });
    if (covering) {
      return this.alreadyGrantedResult(request, {
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        actionClass,
        origin: originDecision.origin,
        url: attachment.url,
        grant: covering,
      });
    }

    const waiting = this.findPendingRequest(request, attachment.profileId, attachment.targetId);
    if (waiting) {
      return this.stillWaitingResult(request, {
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        actionClass,
        origin: originDecision.origin,
        url: attachment.url,
        requestId: waiting.requestId,
      });
    }

    const approval = this.deps.approvalStore.createRequest({
      instanceId: request.instanceId ?? 'unknown',
      provider: providerFromContext(request.provider),
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      toolName: 'browser.request_grant',
      action: 'request_grant',
      actionClass,
      origin: originDecision.origin,
      url: attachment.url,
      proposedGrant: request.proposedGrant,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    const autoGrant = this.deps.autoApproveApproval?.(approval) ?? null;
    if (autoGrant) {
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'request_grant',
        toolName: 'browser.request_grant',
        actionClass,
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Auto-approved Browser Gateway grant request for existing Chrome tab',
        origin: originDecision.origin,
        url: attachment.url,
        grantId: autoGrant.id,
        autonomous: autoGrant.autonomous,
        data: null,
      });
    }

    return this.deps.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: 'request_grant',
      toolName: 'browser.request_grant',
      actionClass,
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: approval.requestId,
      reason: request.reason ?? 'browser_grant_requires_user_approval',
      summary: 'Browser grant request for existing Chrome tab requires user approval',
      origin: originDecision.origin,
      url: attachment.url,
      data: null,
    });
  }

  /**
   * An approval request already waiting on the user that would cover this ask.
   * Reused so a re-request queues behind the open dialog instead of adding a
   * second one for the same site.
   */
  private findPendingRequest(
    request: BrowserGatewayContext & BrowserRequestGrantRequest,
    profileId: string,
    targetId: string,
  ): BrowserApprovalRequest | null {
    if (!request.instanceId) {
      return null;
    }
    const now = Date.now();
    return (
      this.deps.approvalStore
        .listRequests({ instanceId: request.instanceId, status: 'pending' })
        .find(
          (pending) =>
            pending.status === 'pending' &&
            pending.instanceId === request.instanceId &&
            pending.expiresAt > now &&
            pending.toolName === 'browser.request_grant' &&
            pending.profileId === profileId &&
            pending.targetId === targetId &&
            proposalCoversProposal(pending.proposedGrant, request.proposedGrant),
        ) ?? null
    );
  }

  private stillWaitingResult(
    request: BrowserGatewayContext & BrowserRequestGrantRequest,
    scope: {
      profileId: string;
      targetId: string;
      actionClass: ReturnType<typeof primaryActionClass>;
      origin: string;
      url: string;
      requestId: string;
    },
  ): BrowserGatewayResult<null> {
    return this.deps.result({
      context: request,
      profileId: scope.profileId,
      targetId: scope.targetId,
      action: 'request_grant',
      toolName: 'browser.request_grant',
      actionClass: scope.actionClass,
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: scope.requestId,
      // `reason` is the only field the calling agent sees.
      reason:
        'approval_already_pending: this request is already waiting on the user. '
        + 'Do not ask again — poll browser.get_approval_status with this requestId.',
      summary: 'Browser grant request reused the approval already pending for this target',
      origin: scope.origin,
      url: scope.url,
      data: null,
    });
  }

  private alreadyGrantedResult(
    request: BrowserGatewayContext & BrowserRequestGrantRequest,
    scope: {
      profileId: string;
      targetId: string;
      actionClass: ReturnType<typeof primaryActionClass>;
      origin: string;
      url: string;
      grant: BrowserPermissionGrant;
    },
  ): BrowserGatewayResult<null> {
    return this.deps.result({
      context: request,
      profileId: scope.profileId,
      targetId: scope.targetId,
      action: 'request_grant',
      toolName: 'browser.request_grant',
      actionClass: scope.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      // `reason` is the only field the calling agent sees — keep the
      // machine-readable code first, then say what to do instead of re-asking.
      reason:
        'existing_grant_covers_request: you already hold a grant covering these '
        + 'action classes and origins. Do not ask the user again — retry the action '
        + 'that failed. A repeated failure under this grant is not a permission '
        + 'problem (check browser.health and the tab attachment instead).',
      summary: 'Browser grant request already satisfied by an existing grant',
      origin: scope.origin,
      url: scope.url,
      grantId: scope.grant.id,
      autonomous: scope.grant.autonomous,
      data: null,
    });
  }
}
