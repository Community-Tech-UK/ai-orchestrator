import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserGatewayResult,
  BrowserTarget,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserProfileStore } from './browser-profile-store';
import { isOriginAllowed } from './browser-origin-policy';
import { redactElementContext } from './browser-redaction';
import { providerFromContext } from './browser-gateway-action-guard';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';

export class BrowserManualHandoffOperations {
  constructor(private readonly deps: {
    approvalStore: Pick<BrowserApprovalStore, 'createRequest'>;
    extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
    profileStore: Pick<BrowserProfileStore, 'getProfile'>;
    getLiveTarget: (profileId: string, targetId: string) => Promise<{ target: BrowserTarget | null; error?: string }>;
    result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  }) {}

  async createManualHandoffApproval(params: {
    request: BrowserGatewayContext & {
      profileId: string;
      targetId?: string;
      reason?: string;
    };
    toolName: 'browser.request_user_login' | 'browser.pause_for_manual_step';
    action: 'request_user_login' | 'pause_for_manual_step';
    actionClass: BrowserActionClass;
    resultReason: string;
    defaultPrompt: string;
    summary: string;
  }): Promise<BrowserGatewayResult<null>> {
    const scope = await this.resolveManualHandoffScope(params.request);
    if (!scope.allowedOrigin) {
      return this.deps.result({
        context: params.request,
        profileId: params.request.profileId,
        targetId: params.request.targetId,
        action: params.action,
        toolName: params.toolName,
        actionClass: params.actionClass,
        decision: 'denied',
        outcome: 'not_run',
        reason: scope.error ?? 'manual_handoff_scope_unavailable',
        summary: `${params.toolName} denied because Browser Gateway could not resolve an allowed browser scope`,
        url: scope.url,
        data: null,
      });
    }

    const prompt = params.request.reason?.trim() || params.defaultPrompt;
    const approval = this.deps.approvalStore.createRequest({
      instanceId: params.request.instanceId ?? 'unknown',
      provider: providerFromContext(params.request.provider),
      profileId: params.request.profileId,
      targetId: params.request.targetId,
      toolName: params.toolName,
      action: params.action,
      actionClass: params.actionClass,
      origin: scope.origin,
      url: scope.url,
      elementContext: redactElementContext({
        nearbyText: prompt,
      }),
      proposedGrant: {
        mode: 'per_action',
        allowedOrigins: [scope.allowedOrigin],
        allowedActionClasses: ['read'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    return this.deps.result({
      context: params.request,
      profileId: params.request.profileId,
      targetId: params.request.targetId,
      action: params.action,
      toolName: params.toolName,
      actionClass: params.actionClass,
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: approval.requestId,
      reason: params.resultReason,
      summary: params.summary,
      origin: scope.origin,
      url: scope.url,
      data: null,
    });
  }

  private async resolveManualHandoffScope(request: {
    profileId: string;
    targetId?: string;
  }): Promise<{
    allowedOrigin?: BrowserAllowedOrigin;
    origin?: string;
    url?: string;
    error?: string;
  }> {
    if (request.targetId) {
      const existingTab = this.deps.extensionTabStore.getTab(request.profileId, request.targetId);
      if (existingTab) {
        const decision = isOriginAllowed(existingTab.url, existingTab.allowedOrigins);
        if (!decision.allowed) {
          return {
            error: decision.reason,
            origin: decision.origin,
            url: existingTab.url,
          };
        }
        return {
          allowedOrigin: decision.matchedOrigin,
          origin: decision.origin,
          url: existingTab.url,
        };
      }
    }

    const profile = this.deps.profileStore.getProfile(request.profileId);
    if (!profile) {
      return { error: 'profile_not_found' };
    }

    const { target, error } = request.targetId
      ? await this.deps.getLiveTarget(request.profileId, request.targetId)
      : { target: null, error: undefined };
    if (request.targetId && !target) {
      return { error: error ?? 'target_not_found' };
    }

    const currentUrl = target?.url ?? profile.defaultUrl;
    if (currentUrl) {
      const decision = isOriginAllowed(currentUrl, profile.allowedOrigins);
      if (!decision.allowed) {
        return {
          error: decision.reason,
          origin: decision.origin,
          url: currentUrl,
        };
      }
      return {
        allowedOrigin: decision.matchedOrigin,
        origin: decision.origin,
        url: currentUrl,
      };
    }

    const firstAllowedOrigin = profile.allowedOrigins[0];
    return firstAllowedOrigin
      ? { allowedOrigin: firstAllowedOrigin }
      : { error: 'no_allowed_origins_configured' };
  }
}
