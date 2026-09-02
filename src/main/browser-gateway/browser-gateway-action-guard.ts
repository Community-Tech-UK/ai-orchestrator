import type {
  BrowserActionClass,
  BrowserApprovalRequest,
  BrowserGatewayResult,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserExistingTabAttachment, BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserProfileStore } from './browser-profile-store';
import type { BrowserTargetRegistry } from './browser-target-registry';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import { autoApproveBrowserApproval, type BrowserAutoApprovePredicate } from './browser-auto-approve';
import { classifyBrowserAction, LEGAL_DECLARATION_REASON } from './browser-action-classifier';
import type { BrowserEscalationService } from './browser-escalation-store';
import {
  escalationResultForChallenge,
  neverGrantableDenyResult,
  recordDeclarationAutoFireNote,
} from './browser-gateway-hardstop';
import {
  actionClassNeverGrantable,
  actionClassRequiresAutonomy,
  findMatchingBrowserGrant,
} from './browser-grant-policy';
import { isOriginAllowed } from './browser-origin-policy';
import { redactElementContext } from './browser-redaction';
import { existingTabGrantNodeId } from './browser-grant-scope';
import { BrowserExactApprovalRedeemer } from './browser-exact-approval-redemption';
import { createOrReusePendingBrowserApproval } from './browser-pending-approval-match';
import { providerFromContext } from './browser-provider';
import { refreshRegisteredBrowserTarget } from './browser-live-target';
import type {
  BrowserGatewayActionGuardOptions,
  BrowserGatewayMutationPreparation,
  BrowserGatewayPreparedMutation,
} from './browser-gateway-action-guard.types';
export type {
  BrowserGatewayActionGuardOptions,
  BrowserGatewayMutationPreparation,
  BrowserGatewayPreparedMutation,
} from './browser-gateway-action-guard.types';

export class BrowserGatewayActionGuard {
  private readonly profileStore: Pick<BrowserProfileStore, 'getProfile'>;
  private readonly targetRegistry: Pick<BrowserTargetRegistry, 'listTargets'>;
  private readonly driver: Pick<PuppeteerBrowserDriver, 'refreshTarget' | 'inspectElement'>;
  private readonly extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
  private readonly grantStore: Pick<BrowserGrantStore, 'listGrants' | 'createGrant' | 'consumeGrant'>;
  private readonly approvalStore: Pick<
    BrowserApprovalStore,
    'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'
  >;
  private readonly autoApproveRequests?: BrowserAutoApprovePredicate;
  private readonly escalations?: Pick<BrowserEscalationService, 'raise'>;
  private readonly result: BrowserGatewayActionGuardOptions['result'];
  private readonly onGrantedMutation?: BrowserGatewayActionGuardOptions['onGrantedMutation'];
  private readonly exactApprovalRedeemer: BrowserExactApprovalRedeemer;

  constructor(options: BrowserGatewayActionGuardOptions) {
    this.profileStore = options.profileStore;
    this.targetRegistry = options.targetRegistry;
    this.driver = options.driver;
    this.extensionTabStore = options.extensionTabStore;
    this.grantStore = options.grantStore;
    this.approvalStore = options.approvalStore;
    this.autoApproveRequests = options.autoApproveRequests;
    this.escalations = options.escalations;
    this.result = options.result;
    this.onGrantedMutation = options.onGrantedMutation;
    this.exactApprovalRedeemer = new BrowserExactApprovalRedeemer(
      this.approvalStore,
      this.grantStore,
      this.result,
    );
  }

  async prepareMutatingAction(
    request: BrowserGatewayContext & { profileId: string; targetId: string; requestId?: string },
    action: string,
    toolName: string,
    selector: string,
    actionHint?: string,
    classificationOverride?: ReturnType<typeof classifyBrowserAction>,
  ): Promise<BrowserGatewayMutationPreparation> {
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return this.prepareExistingTabMutatingAction(
        request,
        existingTab,
        action,
        toolName,
        selector,
        actionHint,
        classificationOverride,
      );
    }

    const profile = this.profileStore.getProfile(request.profileId);
    const { target, error } = profile
      ? await refreshRegisteredBrowserTarget(
          this.targetRegistry,
          this.driver,
          request.profileId,
          request.targetId,
        )
      : { target: null, error: undefined };
    const currentUrl = target?.url;
    if (!profile || !target || !currentUrl) {
      return {
        result: this.result({
          context: request,
          profileId: request.profileId,
          targetId: request.targetId,
          action,
          toolName,
          actionClass: 'unknown',
          decision: 'denied',
          outcome: 'not_run',
          reason: error ?? 'profile_target_or_url_not_found',
          summary: error
            ? `${toolName} denied because the live browser target could not be refreshed: ${error}`
            : `${toolName} denied because the profile, target, or URL was not found`,
          data: null,
        }),
      };
    }

    const originDecision = isOriginAllowed(currentUrl, profile.allowedOrigins);
    if (!originDecision.allowed) {
      return {
        result: this.result({
          context: request,
          profileId: profile.id,
          targetId: target.id,
          action,
          toolName,
          actionClass: 'unknown',
          decision: 'denied',
          outcome: 'not_run',
          reason: originDecision.reason,
          summary: `${toolName} denied by Browser Gateway origin policy: ${originDecision.reason}`,
          url: currentUrl,
          data: null,
        }),
      };
    }

    let elementContext: Awaited<ReturnType<PuppeteerBrowserDriver['inspectElement']>>;
    try {
      elementContext = redactElementContext(
        await this.driver.inspectElement(profile.id, target.id, selector),
      );
    } catch (inspectError) {
      const message = inspectError instanceof Error ? inspectError.message : String(inspectError);
      const exact = this.exactApprovalRedeemer.prepare({
        context: request, requestId: request.requestId,
        instanceId: request.instanceId ?? 'unknown', provider: providerFromContext(request.provider),
        profileId: profile.id, targetId: target.id, toolName, action, actionClass: 'unknown',
        origin: originDecision.origin, liveOrigin: target.origin ?? originDecision.origin,
        url: currentUrl, selector, hardStop: true, reason: 'element_context_unavailable',
      });
      if (exact) return exact;
      const { approval, reused } = createOrReusePendingBrowserApproval(this.approvalStore, {
        instanceId: request.instanceId ?? 'unknown',
        provider: providerFromContext(request.provider),
        profileId: profile.id,
        targetId: target.id,
        toolName,
        action,
        actionClass: 'unknown',
        origin: originDecision.origin,
        url: currentUrl,
        selector,
        proposedGrant: {
          mode: 'per_action',
          allowedOrigins: [originDecision.matchedOrigin],
          allowedActionClasses: ['unknown'],
          allowExternalNavigation: false,
          autonomous: false,
        },
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      const autoGrant = this.autoApproveApproval(approval);
      if (autoGrant) {
        return {
          grant: autoGrant,
          actionClass: 'unknown',
          origin: originDecision.origin,
          url: currentUrl,
        };
      }
      return {
        result: this.result({
          context: request,
          profileId: profile.id,
          targetId: target.id,
          action,
          toolName,
          actionClass: 'unknown',
          decision: 'requires_user',
          outcome: 'not_run',
          requestId: approval.requestId,
          reason: reused ? 'approval_already_pending' : 'element_context_unavailable',
          summary: `${toolName} requires user approval because element context could not be inspected: ${message}`,
          origin: originDecision.origin,
          url: currentUrl,
          data: null,
        }),
      };
    }
    const classification = classificationOverride ?? classifyBrowserAction({
      toolName,
      actionHint,
      elementContext,
    });
    const grants = this.grantStore.listGrants({
      instanceId: request.instanceId,
      profileId: profile.id,
    });
    const match = findMatchingBrowserGrant({
      grants,
      instanceId: request.instanceId ?? '',
      provider: providerFromContext(request.provider),
      profileId: profile.id,
      targetId: target.id,
      origin: originDecision.origin,
      liveOrigin: target.origin ?? originDecision.origin,
      actionClass: classification.actionClass,
      autonomousRequired: actionClassRequiresAutonomy(classification.actionClass),
    });

    const exact = this.exactApprovalRedeemer.prepare({
      context: request,
      requestId: request.requestId,
      instanceId: request.instanceId ?? 'unknown',
      provider: providerFromContext(request.provider),
      profileId: profile.id,
      targetId: target.id,
      toolName,
      action,
      actionClass: classification.actionClass,
      origin: originDecision.origin,
      liveOrigin: target.origin ?? originDecision.origin,
      url: currentUrl,
      selector,
      hardStop: classification.hardStop,
      reason: classification.reason,
      grant: match.grant,
    });
    if (exact) return exact;

    if (!match.grant || classification.hardStop) {
      const escalated = escalationResultForChallenge(
        { escalations: this.escalations, result: this.result },
        request,
        action,
        toolName,
        classification,
        { profileId: profile.id, targetId: target.id, origin: originDecision.origin, url: currentUrl },
      );
      if (escalated) {
        return { result: escalated };
      }
      // Legal-declaration auto-fire (operator opted into hands-off submits):
      // under a valid autonomous campaign grant a binding declaration proceeds
      // rather than blocking, and is recorded as an audit note. Without such a
      // grant it falls through to the normal per-action approval below.
      if (classification.reason === LEGAL_DECLARATION_REASON && match.grant) {
        recordDeclarationAutoFireNote(
          { result: this.result },
          request,
          action,
          toolName,
          { profileId: profile.id, targetId: target.id, origin: originDecision.origin, url: currentUrl },
          elementContext,
        );
        return {
          grant: match.grant,
          actionClass: classification.actionClass,
          origin: originDecision.origin,
          url: currentUrl,
        };
      }
      // A never-grantable hard stop (genuine payment) can be satisfied by no
      // grant OR approval, so we must NOT raise a per-action approval the user
      // could approve yet which could never permit the action (the approval
      // loop). Terminate with a clear, actionable deny instead.
      if (actionClassNeverGrantable(classification.actionClass)) {
        return {
          result: neverGrantableDenyResult({ result: this.result }, request, action, toolName, classification, {
            profileId: profile.id,
            targetId: target.id,
            origin: originDecision.origin,
            url: currentUrl,
          }),
        };
      }
      const { approval, reused } = createOrReusePendingBrowserApproval(this.approvalStore, {
        instanceId: request.instanceId ?? 'unknown',
        provider: providerFromContext(request.provider),
        profileId: profile.id,
        targetId: target.id,
        toolName,
        action,
        actionClass: classification.actionClass,
        origin: originDecision.origin,
        url: currentUrl,
        selector,
        elementContext,
        proposedGrant: {
          mode: 'per_action',
          allowedOrigins: [originDecision.matchedOrigin],
          allowedActionClasses: [classification.actionClass],
          allowExternalNavigation: false,
          autonomous: false,
        },
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      const autoGrant = this.autoApproveApproval(approval);
      if (autoGrant) {
        return {
          grant: autoGrant,
          actionClass: classification.actionClass,
          origin: originDecision.origin,
          url: currentUrl,
        };
      }
      return {
        result: this.result({
          context: request,
          profileId: profile.id,
          targetId: target.id,
          action,
          toolName,
          actionClass: classification.actionClass,
          decision: 'requires_user',
          outcome: 'not_run',
          requestId: approval.requestId,
          reason: reused ? 'approval_already_pending' : classification.reason ?? match.reason,
          summary: `${toolName} requires user approval`,
          origin: originDecision.origin,
          url: currentUrl,
          data: null,
        }),
      };
    }

    return {
      grant: match.grant,
      actionClass: classification.actionClass,
      origin: originDecision.origin,
      url: currentUrl,
    };
  }

  recheckPreparedGrant(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
    prepared: BrowserGatewayPreparedMutation,
  ): BrowserGatewayResult<null> | null {
    // Existing-tab grants are stored node-scoped (profileId omitted, nodeId
    // set) because the tab's own profileId is per-attachment/ephemeral — see
    // browser-grant-scope.ts. Without this, an approved existing-tab grant
    // could never be found here and every retry re-prompted the user (LT-001).
    const nodeId = existingTabGrantNodeId(request.profileId);
    const grants = this.grantStore.listGrants({
      instanceId: request.instanceId,
      profileId: request.profileId,
      nodeId,
    });
    const match = findMatchingBrowserGrant({
      grants,
      instanceId: request.instanceId ?? '',
      provider: providerFromContext(request.provider),
      nodeId,
      profileId: request.profileId,
      targetId: request.targetId,
      origin: prepared.origin,
      liveOrigin: prepared.origin,
      actionClass: prepared.actionClass,
      autonomousRequired: actionClassRequiresAutonomy(prepared.actionClass),
    });
    if (match.grant?.id === prepared.grant.id) {
      return null;
    }

    this.exactApprovalRedeemer.release(prepared.exactApprovalRequestId);
    prepared.exactApprovalRequestId = undefined;
    const { approval, reused } = createOrReusePendingBrowserApproval(this.approvalStore, {
      instanceId: request.instanceId ?? 'unknown',
      provider: providerFromContext(request.provider),
      profileId: request.profileId,
      targetId: request.targetId,
      toolName,
      action,
      actionClass: prepared.actionClass,
      origin: prepared.origin,
      url: prepared.url,
      proposedGrant: {
        mode: 'per_action',
        allowedOrigins: prepared.grant.allowedOrigins,
        allowedActionClasses: [prepared.actionClass],
        allowExternalNavigation: false,
        uploadRoots: prepared.grant.uploadRoots,
        autonomous: false,
      },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    // YOLO instances must not be blocked by a grant change between preparation
    // and execution — attempt the same auto-approval every other approval
    // creation site performs and adopt the fresh grant for this execution.
    const autoGrant = this.autoApproveApproval(approval);
    if (autoGrant) {
      prepared.grant = autoGrant;
      return null;
    }
    return this.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: prepared.actionClass,
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: approval.requestId,
      reason: reused ? 'approval_already_pending' : match.reason ?? 'grant_changed_before_execution',
      summary: `${toolName} requires user approval because the grant changed before execution`,
      origin: prepared.origin,
      url: prepared.url,
      data: null,
    });
  }

  mutationSucceeded(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
    prepared: BrowserGatewayPreparedMutation,
  ): BrowserGatewayResult<null> {
    this.recordMutationSucceeded(prepared);
    return this.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `${toolName} executed under approved grant`,
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data: null,
    });
  }

  recordMutationSucceeded(prepared: BrowserGatewayPreparedMutation): void {
    try {
      this.onGrantedMutation?.({ grant: prepared.grant, actionClass: prepared.actionClass });
      if (prepared.grant.mode === 'per_action' || prepared.exactApprovalRequestId) {
        this.grantStore.consumeGrant(prepared.grant.id);
      }
    } finally {
      this.exactApprovalRedeemer.release(prepared.exactApprovalRequestId);
    }
  }

  mutationFailed(
    request: BrowserGatewayContext & { profileId: string; targetId: string; requestId?: string },
    action: string,
    toolName: string,
    prepared: BrowserGatewayPreparedMutation,
    error: unknown,
  ): BrowserGatewayResult<null> {
    const message = error instanceof Error ? error.message : String(error);
    if (prepared.exactApprovalRequestId) {
      this.grantStore.consumeGrant(prepared.grant.id);
    }
    this.exactApprovalRedeemer.release(prepared.exactApprovalRequestId);
    return this.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: 'failed',
      reason: message,
      summary: `${toolName} failed: ${message}`,
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data: null,
    });
  }

  private prepareExistingTabMutatingAction(
    request: BrowserGatewayContext & { profileId: string; targetId: string; requestId?: string },
    attachment: BrowserExistingTabAttachment,
    action: string,
    toolName: string,
    selector: string,
    actionHint?: string,
    classificationOverride?: ReturnType<typeof classifyBrowserAction>,
  ): BrowserGatewayMutationPreparation {
    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return {
        result: this.result({
          context: request,
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          action,
          toolName,
          actionClass: 'unknown',
          decision: 'denied',
          outcome: 'not_run',
          reason: originDecision.reason,
          summary: `${toolName} denied by existing Chrome tab origin policy: ${originDecision.reason}`,
          url: attachment.url,
          data: null,
        }),
      };
    }

    const elementContext = redactElementContext({
      visibleText: actionHint,
      nearbyText: actionHint,
    });
    const classification = classificationOverride ?? classifyBrowserAction({
      toolName,
      actionHint,
      elementContext,
    });
    const nodeId = existingTabGrantNodeId(attachment.profileId, attachment.nodeId);
    const grants = this.grantStore.listGrants({
      instanceId: request.instanceId,
      profileId: attachment.profileId,
      nodeId,
    });
    const match = findMatchingBrowserGrant({
      grants,
      instanceId: request.instanceId ?? '',
      provider: providerFromContext(request.provider),
      nodeId,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      origin: originDecision.origin,
      liveOrigin: attachment.origin,
      actionClass: classification.actionClass,
      autonomousRequired: actionClassRequiresAutonomy(classification.actionClass),
    });

    const exact = this.exactApprovalRedeemer.prepare({
      context: request,
      requestId: request.requestId,
      instanceId: request.instanceId ?? 'unknown',
      provider: providerFromContext(request.provider),
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      toolName,
      action,
      actionClass: classification.actionClass,
      origin: originDecision.origin,
      liveOrigin: attachment.origin,
      url: attachment.url,
      selector,
      hardStop: classification.hardStop,
      reason: classification.reason,
      grant: match.grant,
      nodeId,
    });
    if (exact) return exact;

    if (!match.grant || classification.hardStop) {
      const escalated = escalationResultForChallenge(
        { escalations: this.escalations, result: this.result },
        request,
        action,
        toolName,
        classification,
        {
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          origin: originDecision.origin,
          url: attachment.url,
        },
      );
      if (escalated) {
        return { result: escalated };
      }
      if (classification.reason === LEGAL_DECLARATION_REASON && match.grant) {
        recordDeclarationAutoFireNote(
          { result: this.result },
          request,
          action,
          toolName,
          {
            profileId: attachment.profileId,
            targetId: attachment.targetId,
            origin: originDecision.origin,
            url: attachment.url,
          },
          elementContext,
        );
        return {
          grant: match.grant,
          actionClass: classification.actionClass,
          origin: originDecision.origin,
          url: attachment.url,
        };
      }
      if (actionClassNeverGrantable(classification.actionClass)) {
        return {
          result: neverGrantableDenyResult({ result: this.result }, request, action, toolName, classification, {
            profileId: attachment.profileId,
            targetId: attachment.targetId,
            origin: originDecision.origin,
            url: attachment.url,
          }),
        };
      }
      const { approval, reused } = createOrReusePendingBrowserApproval(this.approvalStore, {
        instanceId: request.instanceId ?? 'unknown',
        provider: providerFromContext(request.provider),
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        toolName,
        action,
        actionClass: classification.actionClass,
        origin: originDecision.origin,
        url: attachment.url,
        selector,
        elementContext,
        proposedGrant: {
          mode: 'per_action',
          ...(nodeId ? { nodeId } : {}),
          allowedOrigins: [originDecision.matchedOrigin],
          allowedActionClasses: [classification.actionClass],
          allowExternalNavigation: false,
          autonomous: false,
        },
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      const autoGrant = this.autoApproveApproval(approval);
      if (autoGrant) {
        return {
          grant: autoGrant,
          actionClass: classification.actionClass,
          origin: originDecision.origin,
          url: attachment.url,
        };
      }
      return {
        result: this.result({
          context: request,
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          action,
          toolName,
          actionClass: classification.actionClass,
          decision: 'requires_user',
          outcome: 'not_run',
          requestId: approval.requestId,
          reason: reused ? 'approval_already_pending' : classification.reason ?? match.reason,
          summary: `${toolName} requires user approval for existing Chrome tab control`,
          origin: originDecision.origin,
          url: attachment.url,
          data: null,
        }),
      };
    }

    return {
      grant: match.grant,
      actionClass: classification.actionClass,
      origin: originDecision.origin,
      url: attachment.url,
    };
  }

  private autoApproveApproval(approval: BrowserApprovalRequest): BrowserPermissionGrant | null {
    return autoApproveBrowserApproval({
      approval,
      approvalStore: this.approvalStore,
      grantStore: this.grantStore,
      autoApproveRequests: this.autoApproveRequests,
    });
  }

}
