import type {
  BrowserActionClass,
  BrowserApprovalRequest,
  BrowserGatewayResult,
  BrowserPermissionGrant,
  BrowserProvider,
  BrowserTarget,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserExistingTabAttachment, BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserProfileStore } from './browser-profile-store';
import type { BrowserTargetRegistry } from './browser-target-registry';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import {
  autoApproveBrowserApproval,
  type BrowserAutoApprovePredicate,
} from './browser-auto-approve';
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

export interface BrowserGatewayPreparedMutation {
  grant: BrowserPermissionGrant;
  actionClass: BrowserActionClass;
  origin: string;
  url: string;
}

export type BrowserGatewayMutationPreparation =
  | {
      result: BrowserGatewayResult<null>;
    }
  | ({
      result?: undefined;
    } & BrowserGatewayPreparedMutation);

export interface BrowserGatewayActionGuardOptions {
  profileStore: Pick<BrowserProfileStore, 'getProfile'>;
  targetRegistry: Pick<BrowserTargetRegistry, 'listTargets'>;
  driver: Pick<PuppeteerBrowserDriver, 'refreshTarget' | 'inspectElement'>;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
  grantStore: Pick<BrowserGrantStore, 'listGrants' | 'createGrant' | 'consumeGrant'>;
  approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'resolveRequest'>;
  autoApproveRequests?: BrowserAutoApprovePredicate;
  /**
   * When present, captcha / 2FA hard stops are parked to the batch escalation
   * queue (and the action stops) instead of raising a blocking per-action
   * approval an unattended run cannot answer. Omitted → the legacy approval
   * path is used for every hard stop.
   */
  escalations?: Pick<BrowserEscalationService, 'raise'>;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  /**
   * Fired for every successfully executed guarded mutation with the grant it
   * ran under. Used for campaign budget enforcement — must never throw.
   */
  onGrantedMutation?: (info: {
    grant: BrowserPermissionGrant;
    actionClass: BrowserActionClass;
  }) => void;
}

export class BrowserGatewayActionGuard {
  private readonly profileStore: Pick<BrowserProfileStore, 'getProfile'>;
  private readonly targetRegistry: Pick<BrowserTargetRegistry, 'listTargets'>;
  private readonly driver: Pick<PuppeteerBrowserDriver, 'refreshTarget' | 'inspectElement'>;
  private readonly extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
  private readonly grantStore: Pick<BrowserGrantStore, 'listGrants' | 'createGrant' | 'consumeGrant'>;
  private readonly approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'resolveRequest'>;
  private readonly autoApproveRequests?: BrowserAutoApprovePredicate;
  private readonly escalations?: Pick<BrowserEscalationService, 'raise'>;
  private readonly result: BrowserGatewayActionGuardOptions['result'];
  private readonly onGrantedMutation?: BrowserGatewayActionGuardOptions['onGrantedMutation'];

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
  }

  async prepareMutatingAction(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
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
      ? await this.getLiveTarget(request.profileId, request.targetId)
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
      const approval = this.approvalStore.createRequest({
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
          reason: 'element_context_unavailable',
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
      const approval = this.approvalStore.createRequest({
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
          reason: classification.reason ?? match.reason,
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

    const approval = this.approvalStore.createRequest({
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
      reason: match.reason ?? 'grant_changed_before_execution',
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
    this.onGrantedMutation?.({ grant: prepared.grant, actionClass: prepared.actionClass });
    if (prepared.grant.mode === 'per_action') {
      this.grantStore.consumeGrant(prepared.grant.id);
    }
  }

  mutationFailed(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
    prepared: BrowserGatewayPreparedMutation,
    error: unknown,
  ): BrowserGatewayResult<null> {
    const message = error instanceof Error ? error.message : String(error);
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
    request: BrowserGatewayContext & { profileId: string; targetId: string },
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
      const approval = this.approvalStore.createRequest({
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
          reason: classification.reason ?? match.reason,
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

  private getTarget(profileId: string, targetId: string): BrowserTarget | null {
    return (
      this.targetRegistry
        .listTargets(profileId)
        .find((target) => target.id === targetId) ?? null
    );
  }

  private autoApproveApproval(approval: BrowserApprovalRequest): BrowserPermissionGrant | null {
    return autoApproveBrowserApproval({
      approval,
      approvalStore: this.approvalStore,
      grantStore: this.grantStore,
      autoApproveRequests: this.autoApproveRequests,
    });
  }

  private async getLiveTarget(
    profileId: string,
    targetId: string,
  ): Promise<{ target: BrowserTarget | null; error?: string }> {
    const target = this.getTarget(profileId, targetId);
    if (!target) {
      return { target: null };
    }

    try {
      return {
        target: await this.driver.refreshTarget(profileId, targetId),
      };
    } catch (error) {
      return {
        target: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function providerFromContext(provider: string | undefined): BrowserProvider {
  return provider === 'claude' ||
    provider === 'codex' ||
    provider === 'gemini' ||
    provider === 'antigravity' ||
    provider === 'copilot' ||
    provider === 'cursor' ||
    provider === 'grok' ||
    provider === 'orchestrator'
    ? provider
    : 'orchestrator';
}
