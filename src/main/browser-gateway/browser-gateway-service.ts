import * as path from 'node:path';
import type {
  BrowserActionClass,
  BrowserApprovalRequest,
  BrowserApprovalRequestLookup,
  BrowserApprovalStatusRequest,
  BrowserApproveRequestPayload,
  BrowserAttachExistingTabRequest,
  BrowserAuditEntry,
  BrowserClickRequest,
  BrowserCreateGrantRequest,
  BrowserCreateProfileRequest,
  BrowserDenyRequestPayload,
  BrowserFillFormRequest,
  BrowserGatewayDecision,
  BrowserGatewayOutcome,
  BrowserGatewayResult,
  BrowserGrantMode,
  BrowserListAuditLogRequest,
  BrowserListApprovalRequestsRequest,
  BrowserListGrantsRequest,
  BrowserPermissionGrant,
  BrowserProvider,
  BrowserRequestGrantRequest,
  BrowserRevokeGrantRequest,
  BrowserSelectRequest,
  BrowserProfile,
  BrowserScreenshotRequest,
  BrowserTypeRequest,
  BrowserUpdateProfileRequest,
  BrowserUploadFileRequest,
  BrowserTarget,
} from '@contracts/types/browser';
import {
  BrowserAuditStore,
  type BrowserAuditEntryInput,
  getBrowserAuditStore,
} from './browser-audit-store';
import {
  BrowserApprovalStore,
  getBrowserApprovalStore,
} from './browser-approval-store';
import {
  BrowserGrantStore,
  getBrowserGrantStore,
} from './browser-grant-store';
import {
  BrowserProfileStore,
  getBrowserProfileStore,
} from './browser-profile-store';
import {
  BrowserProfileRegistry,
  getBrowserProfileRegistry,
} from './browser-profile-registry';
import {
  BrowserTargetRegistry,
  getBrowserTargetRegistry,
} from './browser-target-registry';
import {
  PuppeteerBrowserDriver,
  getPuppeteerBrowserDriver,
  type BrowserSnapshot,
} from './puppeteer-browser-driver';
import {
  BrowserHealthService,
  getBrowserHealthService,
} from './browser-health-service';
import { isOriginAllowed } from './browser-origin-policy';
import {
  toAgentSafeAudit,
  toAgentSafeHealth,
  toAgentSafeProfile,
  toAgentSafeTarget,
  redactAgentString,
} from './browser-safe-dto';
import {
  redactBrowserNetworkRequests,
  redactBrowserText,
  redactElementContext,
} from './browser-redaction';
import {
  classifyBrowserAction,
  classifyBrowserFillForm,
} from './browser-action-classifier';
import { findMatchingBrowserGrant } from './browser-grant-policy';
import { validateBrowserUploadPath } from './browser-upload-policy';
import {
  BrowserExtensionTabStore,
  type BrowserExistingTabAttachment,
  type BrowserExtensionCommand,
  type BrowserExtensionCompleteCommandRequest,
  type BrowserExtensionPollCommandRequest,
  getBrowserExtensionTabStore,
} from './browser-extension-tab-store';

export interface BrowserGatewayContext {
  instanceId?: string;
  provider?: string;
}

export interface BrowserGatewayNavigateRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
  url: string;
}

export interface BrowserGatewayTargetRequest extends BrowserGatewayContext {
  profileId: string;
  targetId: string;
}

export interface BrowserGatewayScreenshotRequest
  extends BrowserGatewayContext,
    BrowserScreenshotRequest {}

export interface BrowserGatewayListTargetsRequest extends BrowserGatewayContext {
  profileId?: string;
}

export interface BrowserGatewayAuditLogRequest
  extends BrowserGatewayContext,
    BrowserListAuditLogRequest {}

export interface BrowserGatewayCreateProfileRequest
  extends BrowserGatewayContext,
    BrowserCreateProfileRequest {}

export interface BrowserGatewayAttachExistingTabRequest
  extends BrowserGatewayContext,
    BrowserAttachExistingTabRequest {}

export interface BrowserGatewayExistingTabRefresh {
  commandId: string;
  status: BrowserExtensionCommand['status'];
  profileId: string;
  targetId: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserGatewayUpdateProfileRequest
  extends BrowserGatewayContext,
    BrowserUpdateProfileRequest {
  profileId: string;
}

export interface BrowserGatewayMutatingActionRequest extends BrowserGatewayContext {
  toolName: string;
  action: string;
  profileId?: string;
  targetId?: string;
}

export interface BrowserGatewayServiceOptions {
  profileStore?: Pick<
    BrowserProfileStore,
    'listProfiles' | 'getProfile' | 'updateProfile' | 'deleteProfile'
  >;
  profileRegistry?: Pick<BrowserProfileRegistry, 'createProfile' | 'resolveProfileDir'>;
  targetRegistry?: Pick<BrowserTargetRegistry, 'listTargets' | 'selectTarget'>;
  driver?: Pick<
    PuppeteerBrowserDriver,
    | 'openProfile'
    | 'closeProfile'
    | 'listTargets'
    | 'refreshTarget'
    | 'navigate'
    | 'snapshot'
    | 'screenshot'
    | 'consoleMessages'
    | 'networkRequests'
    | 'waitFor'
    | 'inspectElement'
    | 'click'
    | 'type'
    | 'fillForm'
    | 'select'
    | 'uploadFile'
  >;
  extensionTabStore?: Pick<
    BrowserExtensionTabStore,
    'attachTab' | 'getTab' | 'detachTab' | 'queueRefresh' | 'pollCommand' | 'completeCommand'
  >;
  auditStore?: Pick<BrowserAuditStore, 'record' | 'list'>;
  grantStore?: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant' | 'createGrant' | 'revokeGrant'>;
  approvalStore?: Pick<BrowserApprovalStore, 'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'>;
  healthService?: Pick<BrowserHealthService, 'diagnose'>;
}

export class BrowserGatewayService {
  private static instance: BrowserGatewayService | null = null;
  private readonly profileStore: Pick<
    BrowserProfileStore,
    'listProfiles' | 'getProfile' | 'updateProfile' | 'deleteProfile'
  >;
  private readonly profileRegistry: Pick<BrowserProfileRegistry, 'createProfile' | 'resolveProfileDir'>;
  private readonly targetRegistry: Pick<BrowserTargetRegistry, 'listTargets' | 'selectTarget'>;
  private readonly driver: Pick<
    PuppeteerBrowserDriver,
    | 'openProfile'
    | 'closeProfile'
    | 'listTargets'
    | 'refreshTarget'
    | 'navigate'
    | 'snapshot'
    | 'screenshot'
    | 'consoleMessages'
    | 'networkRequests'
    | 'waitFor'
    | 'inspectElement'
    | 'click'
    | 'type'
    | 'fillForm'
    | 'select'
    | 'uploadFile'
  >;
  private readonly extensionTabStore: Pick<
    BrowserExtensionTabStore,
    'attachTab' | 'getTab' | 'detachTab' | 'queueRefresh' | 'pollCommand' | 'completeCommand'
  >;
  private readonly auditStore: Pick<BrowserAuditStore, 'record' | 'list'>;
  private readonly grantStore: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant' | 'createGrant' | 'revokeGrant'>;
  private readonly approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'>;
  private readonly healthService: Pick<BrowserHealthService, 'diagnose'>;

  constructor(options: BrowserGatewayServiceOptions = {}) {
    this.profileStore = options.profileStore ?? getBrowserProfileStore();
    this.profileRegistry = options.profileRegistry ?? getBrowserProfileRegistry();
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.driver = options.driver ?? getPuppeteerBrowserDriver();
    this.extensionTabStore = options.extensionTabStore ?? getBrowserExtensionTabStore();
    this.auditStore = options.auditStore ?? getBrowserAuditStore();
    this.grantStore = options.grantStore ?? getBrowserGrantStore();
    this.approvalStore = options.approvalStore ?? getBrowserApprovalStore();
    this.healthService = options.healthService ?? getBrowserHealthService();
  }

  static getInstance(): BrowserGatewayService {
    if (!this.instance) {
      this.instance = new BrowserGatewayService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async listProfiles(
    context: BrowserGatewayContext = {},
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeProfile>[]>> {
    const profiles = this.profileStore.listProfiles().map((profile) =>
      toAgentSafeProfile(profile),
    );
    const noProfilesReason = profiles.length === 0
      ? 'no_profiles_configured_call_browser_create_profile_then_browser_open_profile'
      : undefined;
    return this.result({
      context,
      action: 'list_profiles',
      toolName: 'browser.list_profiles',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      reason: noProfilesReason,
      summary: profiles.length === 0
        ? 'No managed Browser Gateway profiles are configured; agents can create one with browser.create_profile, or call browser.list_targets to check for user-selected existing Chrome tabs.'
        : `Listed ${profiles.length} browser profiles`,
      data: profiles,
    });
  }

  async createProfile(
    request: BrowserGatewayCreateProfileRequest,
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeProfile>>> {
    const { instanceId, provider, ...input } = request;
    const profile = toAgentSafeProfile(this.profileRegistry.createProfile(input));
    return this.result({
      context: { instanceId, provider },
      profileId: profile.id,
      action: 'create_profile',
      toolName: 'browser.create_profile',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Created browser profile ${profile.label}`,
      data: profile,
    });
  }

  async attachExistingTab(
    request: BrowserGatewayAttachExistingTabRequest,
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeTarget> | null>> {
    const { instanceId, provider, ...input } = request;
    try {
      const attachment = this.extensionTabStore.attachTab(input);
      return this.result({
        context: { instanceId, provider: provider ?? 'orchestrator' },
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'attach_existing_tab',
        toolName: 'browser.extension_attach_tab',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: `Attached existing Chrome tab ${attachment.title ?? attachment.url}`,
        origin: attachment.origin,
        url: attachment.url,
        data: this.safeTargetFromExistingTab(attachment),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: { instanceId, provider: provider ?? 'orchestrator' },
        action: 'attach_existing_tab',
        toolName: 'browser.extension_attach_tab',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: message,
        summary: `Existing Chrome tab attachment denied: ${message}`,
        url: input.url,
        data: null,
      });
    }
  }

  async refreshExistingTab(
    request: BrowserGatewayTargetRequest,
  ): Promise<BrowserGatewayResult<BrowserGatewayExistingTabRefresh | null>> {
    const attachment = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (!attachment) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'refresh_existing_tab',
        toolName: 'browser.refresh_existing_tab',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'existing_tab_not_found',
        summary: 'Existing Chrome tab refresh denied because the tab was not shared with Browser Gateway',
        data: null,
      });
    }

    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'refresh_existing_tab',
        toolName: 'browser.refresh_existing_tab',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Existing Chrome tab refresh denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: attachment.url,
        data: null,
      });
    }

    const command = this.extensionTabStore.queueRefresh(
      attachment.profileId,
      attachment.targetId,
    );
    if (!command) {
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'refresh_existing_tab',
        toolName: 'browser.refresh_existing_tab',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'existing_tab_not_found',
        summary: 'Existing Chrome tab refresh denied because the selected tab disappeared',
        url: attachment.url,
        data: null,
      });
    }

    return this.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: 'refresh_existing_tab',
      toolName: 'browser.refresh_existing_tab',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Queued refresh for selected existing Chrome tab',
      origin: originDecision.origin,
      url: attachment.url,
      data: this.safeExistingTabCommand(command),
    });
  }

  pollExistingTabCommand(
    request: BrowserExtensionPollCommandRequest,
  ): BrowserExtensionCommand | null {
    return this.extensionTabStore.pollCommand(request);
  }

  async completeExistingTabCommand(
    request: BrowserExtensionCompleteCommandRequest,
  ): Promise<BrowserGatewayResult<BrowserGatewayExistingTabRefresh | null>> {
    const command = this.extensionTabStore.completeCommand(request);
    const attachment = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (!command) {
      return this.result({
        context: { provider: 'orchestrator' },
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'complete_existing_tab_command',
        toolName: 'browser.extension_complete_command',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'existing_tab_command_not_found',
        summary: 'Existing Chrome tab command completion denied because the command was not found',
        data: null,
      });
    }

    return this.result({
      context: { provider: 'orchestrator' },
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'complete_existing_tab_command',
      toolName: 'browser.extension_complete_command',
      actionClass: 'read',
      decision: 'allowed',
      outcome: command.status === 'failed' ? 'failed' : 'succeeded',
      reason: command.error,
      summary: command.status === 'failed'
        ? `Existing Chrome tab refresh failed: ${command.error ?? 'unknown error'}`
        : 'Existing Chrome tab refresh completed',
      origin: attachment?.origin,
      url: attachment?.url,
      data: this.safeExistingTabCommand(command),
    });
  }

  async updateProfile(
    request: BrowserGatewayUpdateProfileRequest,
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeProfile>>> {
    const { instanceId, provider, profileId, ...patch } = request;
    const profile = toAgentSafeProfile(this.profileStore.updateProfile(profileId, patch));
    return this.result({
      context: { instanceId, provider },
      profileId,
      action: 'update_profile',
      toolName: 'browser.update_profile',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Updated browser profile ${profile.label}`,
      data: profile,
    });
  }

  async deleteProfile(
    request: BrowserGatewayContext & { profileId: string },
  ): Promise<BrowserGatewayResult<null>> {
    await this.driver.closeProfile(request.profileId).catch(() => undefined);
    this.profileStore.deleteProfile(request.profileId);
    return this.result({
      context: request,
      profileId: request.profileId,
      action: 'delete_profile',
      toolName: 'browser.delete_profile',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Deleted browser profile',
      data: null,
    });
  }

  async openProfile(
    request: BrowserGatewayContext & { profileId: string },
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeTarget>[] | null>> {
    const profile = this.profileStore.getProfile(request.profileId);
    if (!profile) {
      return this.result({
        context: request,
        profileId: request.profileId,
        action: 'open_profile',
        toolName: 'browser.open_profile',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'profile_not_found',
        summary: 'Open profile denied because the profile was not found',
        data: null,
      });
    }

    if (profile.defaultUrl) {
      const originDecision = isOriginAllowed(profile.defaultUrl, profile.allowedOrigins);
      if (!originDecision.allowed) {
        return this.result({
          context: request,
          profileId: profile.id,
          action: 'open_profile',
          toolName: 'browser.open_profile',
          actionClass: 'read',
          decision: 'denied',
          outcome: 'not_run',
          reason: originDecision.reason,
          summary: `Open profile denied because the default URL is outside Browser Gateway origin policy: ${originDecision.reason}`,
          url: profile.defaultUrl,
          data: null,
        });
      }
    }

    try {
      const targets = await this.driver.openProfile(
        {
          ...profile,
          userDataDir: profile.userDataDir ?? this.profileRegistry.resolveProfileDir(profile.id),
        },
        profile.defaultUrl,
      );
      return this.result({
        context: request,
        profileId: profile.id,
        action: 'open_profile',
        toolName: 'browser.open_profile',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Opened browser profile',
        data: targets.map((target) => toAgentSafeTarget(target)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: profile.id,
        action: 'open_profile',
        toolName: 'browser.open_profile',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Open profile failed: ${message}`,
        data: null,
      });
    }
  }

  async closeProfile(
    request: BrowserGatewayContext & { profileId: string },
  ): Promise<BrowserGatewayResult<null>> {
    try {
      await this.driver.closeProfile(request.profileId);
      return this.result({
        context: request,
        profileId: request.profileId,
        action: 'close_profile',
        toolName: 'browser.close_profile',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Closed browser profile',
        data: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: request.profileId,
        action: 'close_profile',
        toolName: 'browser.close_profile',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Close profile failed: ${message}`,
        data: null,
      });
    }
  }

  async listTargets(
    request: BrowserGatewayListTargetsRequest = {},
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeTarget>[]>> {
    const liveTargets = request.profileId
      ? await this.driver.listTargets(request.profileId).catch(() => null)
      : null;
    const targets = (liveTargets ?? this.targetRegistry.listTargets(request.profileId))
      .map((target) => toAgentSafeTarget(target));
    return this.result({
      context: request,
      profileId: request.profileId,
      action: 'list_targets',
      toolName: 'browser.list_targets',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Listed ${targets.length} browser targets`,
      data: targets,
    });
  }

  async selectTarget(
    request: BrowserGatewayTargetRequest,
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeTarget> | null>> {
    const current = this.getTarget(request.profileId, request.targetId);
    if (!current) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'select_target',
        toolName: 'browser.select_target',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'target_not_found',
        summary: 'Target selection denied because the target was not found',
        data: null,
      });
    }

    if (current.profileId !== request.profileId) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'select_target',
        toolName: 'browser.select_target',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'target_profile_mismatch',
        summary: 'Target selection denied because the target belongs to a different profile',
        data: null,
      });
    }

    const target = this.targetRegistry.selectTarget(request.targetId);
    return this.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'select_target',
      toolName: 'browser.select_target',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Selected browser target',
      data: toAgentSafeTarget(target),
    });
  }

  async getHealth(
    context: BrowserGatewayContext = {},
  ): Promise<BrowserGatewayResult<unknown>> {
    const health = toAgentSafeHealth(await this.healthService.diagnose());
    return this.result({
      context,
      action: 'get_health',
      toolName: 'browser.health',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read Browser Gateway health',
      data: health,
    });
  }

  async getAuditLog(
    request: BrowserGatewayAuditLogRequest = {},
  ): Promise<BrowserGatewayResult<BrowserAuditEntry[]>> {
    const audit = this.auditStore.list({
      profileId: request.profileId,
      instanceId: request.instanceId,
      limit: request.limit ?? 100,
    }).map((entry) => toAgentSafeAudit(entry));
    return this.result({
      context: request,
      action: 'get_audit_log',
      toolName: 'browser.get_audit_log',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Read ${audit.length} Browser Gateway audit entries`,
      data: audit,
    });
  }

  async navigate(
    request: BrowserGatewayNavigateRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const profile = this.profileStore.getProfile(request.profileId);
    const target = this.getTarget(request.profileId, request.targetId);
    if (!profile || !target) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'profile_or_target_not_found',
        summary: 'Navigation denied because the profile or target was not found',
        url: request.url,
        data: null,
      });
    }

    const originDecision = isOriginAllowed(request.url, profile.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Navigation denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: request.url,
        data: null,
      });
    }

    try {
      await this.driver.navigate(profile.id, target.id, request.url);
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Navigated within allowed origin',
        origin: originDecision.origin,
        url: request.url,
        data: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Navigation failed: ${message}`,
        origin: originDecision.origin,
        url: request.url,
        data: null,
      });
    }
  }

  async snapshot(
    request: BrowserGatewayTargetRequest,
  ): Promise<BrowserGatewayResult<(BrowserSnapshot & { text: string }) | null>> {
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return this.snapshotExistingTab(request, existingTab);
    }

    const profile = this.profileStore.getProfile(request.profileId);
    const { target, error } = profile
      ? await this.getLiveTarget(request.profileId, request.targetId)
      : { target: null, error: undefined };
    const currentUrl = target?.url;
    if (!profile || !target || !currentUrl) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: error ?? 'profile_target_or_url_not_found',
        summary: error
          ? `Snapshot denied because the live browser target could not be refreshed: ${error}`
          : 'Snapshot denied because the profile, target, or URL was not found',
        data: null,
      });
    }

    const originDecision = isOriginAllowed(currentUrl, profile.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Snapshot denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: currentUrl,
        data: null,
      });
    }

    try {
      const snapshot = await this.driver.snapshot(profile.id, target.id);
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Captured text snapshot from allowed origin',
        origin: originDecision.origin,
        url: currentUrl,
        data: {
          ...snapshot,
          text: redactBrowserText(snapshot.text).slice(0, 12_000),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Snapshot failed: ${message}`,
        origin: originDecision.origin,
        url: currentUrl,
        data: null,
      });
    }
  }

  async screenshot(
    request: BrowserGatewayScreenshotRequest,
  ): Promise<BrowserGatewayResult<string | null>> {
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return this.screenshotExistingTab(request, existingTab);
    }

    const profile = this.profileStore.getProfile(request.profileId);
    const { target, error } = profile
      ? await this.getLiveTarget(request.profileId, request.targetId)
      : { target: null, error: undefined };
    const currentUrl = target?.url;
    if (!profile || !target || !currentUrl) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: error ?? 'profile_target_or_url_not_found',
        summary: error
          ? `Screenshot denied because the live browser target could not be refreshed: ${error}`
          : 'Screenshot denied because the profile, target, or URL was not found',
        data: null,
      });
    }

    const originDecision = isOriginAllowed(currentUrl, profile.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Screenshot denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: currentUrl,
        data: null,
      });
    }

    try {
      const screenshot = await this.driver.screenshot(profile.id, target.id, {
        fullPage: request.fullPage ?? true,
      });
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Captured screenshot from allowed origin',
        origin: originDecision.origin,
        url: currentUrl,
        data: screenshot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Screenshot failed: ${message}`,
        origin: originDecision.origin,
        url: currentUrl,
        data: null,
      });
    }
  }

  async consoleMessages(
    request: BrowserGatewayTargetRequest,
  ): Promise<BrowserGatewayResult<unknown[] | null>> {
    return this.readTargetData(
      request,
      'console_messages',
      'browser.console_messages',
      'console messages',
      (profileId, targetId) => this.driver.consoleMessages(profileId, targetId),
    );
  }

  async networkRequests(
    request: BrowserGatewayTargetRequest,
  ): Promise<BrowserGatewayResult<unknown[] | null>> {
    return this.readTargetData(
      request,
      'network_requests',
      'browser.network_requests',
      'network requests',
      async (profileId, targetId) =>
        redactBrowserNetworkRequests(await this.driver.networkRequests(profileId, targetId)),
    );
  }

  async waitFor(
    request: BrowserGatewayTargetRequest & { selector?: string; timeoutMs?: number },
  ): Promise<BrowserGatewayResult<null>> {
    const selector = request.selector ?? 'body';
    const timeoutMs = request.timeoutMs ?? 30_000;
    const result = await this.readTargetData(
      request,
      'wait_for',
      'browser.wait_for',
      'wait condition',
      async (profileId, targetId) => {
        await this.driver.waitFor(profileId, targetId, selector, timeoutMs);
        return null;
      },
    );
    return result as BrowserGatewayResult<null>;
  }

  async requireUserForMutatingAction(
    request: BrowserGatewayMutatingActionRequest,
  ): Promise<BrowserGatewayResult<null>> {
    return this.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: request.action,
      toolName: request.toolName,
      actionClass: 'input',
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: `browser-${Date.now()}`,
      reason: 'mutating_browser_action_requires_user',
      summary: `${request.toolName} requires user approval and is not exposed in this milestone`,
      data: null,
    });
  }

  async click(
    request: BrowserGatewayContext & BrowserClickRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const prepared = await this.prepareMutatingAction(
      request,
      'click',
      'browser.click',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.recheckPreparedGrant(request, 'click', 'browser.click', prepared);
    if (recheck) {
      return recheck;
    }

    try {
      await this.driver.click(request.profileId, request.targetId, request.selector);
      if (prepared.grant.mode === 'per_action') {
        this.grantStore.consumeGrant(prepared.grant.id);
      }
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'click',
        toolName: 'browser.click',
        actionClass: prepared.actionClass,
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Executed browser click under approved grant',
        origin: prepared.origin,
        url: prepared.url,
        grantId: prepared.grant.id,
        autonomous: prepared.grant.autonomous,
        data: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'click',
        toolName: 'browser.click',
        actionClass: prepared.actionClass,
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Browser click failed: ${message}`,
        origin: prepared.origin,
        url: prepared.url,
        grantId: prepared.grant.id,
        autonomous: prepared.grant.autonomous,
        data: null,
      });
    }
  }

  async type(
    request: BrowserGatewayContext & BrowserTypeRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const prepared = await this.prepareMutatingAction(
      request,
      'type',
      'browser.type',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.recheckPreparedGrant(request, 'type', 'browser.type', prepared);
    if (recheck) {
      return recheck;
    }
    try {
      await this.driver.type(request.profileId, request.targetId, request.selector, request.value);
      return this.mutationSucceeded(request, 'type', 'browser.type', prepared);
    } catch (error) {
      return this.mutationFailed(request, 'type', 'browser.type', prepared, error);
    }
  }

  async select(
    request: BrowserGatewayContext & BrowserSelectRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const prepared = await this.prepareMutatingAction(
      request,
      'select',
      'browser.select',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.recheckPreparedGrant(request, 'select', 'browser.select', prepared);
    if (recheck) {
      return recheck;
    }
    try {
      await this.driver.select(request.profileId, request.targetId, request.selector, request.value);
      return this.mutationSucceeded(request, 'select', 'browser.select', prepared);
    } catch (error) {
      return this.mutationFailed(request, 'select', 'browser.select', prepared, error);
    }
  }

  async uploadFile(
    request: BrowserGatewayContext & BrowserUploadFileRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const prepared = await this.prepareMutatingAction(
      request,
      'upload_file',
      'browser.upload_file',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.recheckPreparedGrant(
      request,
      'upload_file',
      'browser.upload_file',
      prepared,
    );
    if (recheck) {
      return recheck;
    }
    const profile = this.profileStore.getProfile(request.profileId);
    if (!profile) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'upload_file',
        toolName: 'browser.upload_file',
        actionClass: 'file-upload',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'profile_not_found',
        summary: 'browser.upload_file denied because the profile was not found',
        data: null,
      });
    }
    const profileRoot = this.resolveProfileRoot(profile);
    const uploadDecision = validateBrowserUploadPath({
      filePath: request.filePath,
      workspaceRoots: [],
      approvedRoots: prepared.grant.uploadRoots ?? [],
      userDataPath: path.dirname(profileRoot),
      profileRoot,
      autonomous: prepared.grant.autonomous,
    });
    if (!uploadDecision.allowed) {
      const uploadRoots = this.proposedUploadRoots(
        prepared.grant.uploadRoots,
        uploadDecision.resolvedPath,
      );
      const approval = this.approvalStore.createRequest({
        instanceId: request.instanceId ?? 'unknown',
        provider: this.providerFromContext(request.provider),
        profileId: request.profileId,
        targetId: request.targetId,
        toolName: 'browser.upload_file',
        action: 'upload_file',
        actionClass: 'file-upload',
        origin: prepared.origin,
        url: prepared.url,
        selector: request.selector,
        filePath: uploadDecision.resolvedPath ?? request.filePath,
        detectedFileType: uploadDecision.detectedFileType,
        proposedGrant: {
          mode: uploadDecision.requiresPerActionApproval ? 'per_action' : 'session',
          allowedOrigins: prepared.grant.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          allowExternalNavigation: false,
          uploadRoots,
          autonomous: false,
        },
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'upload_file',
        toolName: 'browser.upload_file',
        actionClass: 'file-upload',
        decision: 'requires_user',
        outcome: 'not_run',
        requestId: approval.requestId,
        reason: uploadDecision.reason,
        summary: `browser.upload_file requires user approval: ${uploadDecision.reason}`,
        origin: prepared.origin,
        url: prepared.url,
        data: null,
      });
    }
    try {
      await this.driver.uploadFile(
        request.profileId,
        request.targetId,
        request.selector,
        uploadDecision.resolvedPath ?? request.filePath,
      );
      return this.mutationSucceeded(request, 'upload_file', 'browser.upload_file', prepared);
    } catch (error) {
      return this.mutationFailed(request, 'upload_file', 'browser.upload_file', prepared, error);
    }
  }

  async fillForm(
    request: BrowserGatewayContext & BrowserFillFormRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const firstField = request.fields[0]!;
    const gate = await this.prepareMutatingAction(
      request,
      'fill_form',
      'browser.fill_form',
      firstField.selector,
      firstField.actionHint,
      {
        actionClass: 'input',
        hardStop: false,
      },
    );
    if (gate.result) {
      return gate.result;
    }

    const inspectedFields = [];
    for (const field of request.fields) {
      try {
        inspectedFields.push({
          selector: field.selector,
          actionHint: field.actionHint,
          elementContext: redactElementContext(
            await this.driver.inspectElement(
              request.profileId,
              request.targetId,
              field.selector,
            ),
          ),
        });
      } catch {
        const prepared = await this.prepareMutatingAction(
          request,
          'fill_form',
          'browser.fill_form',
          field.selector,
          field.actionHint,
          {
            actionClass: 'unknown',
            hardStop: true,
            reason: 'element_context_unavailable',
          },
        );
        if (prepared.result) {
          return prepared.result;
        }
        throw new Error('Browser fill_form element inspection failed without producing an approval request');
      }
    }
    const classification = classifyBrowserFillForm(inspectedFields);
    if (classification.actionClass === 'credential' || classification.actionClass === 'unknown') {
      const prepared = await this.prepareMutatingAction(
        request,
        'fill_form',
        'browser.fill_form',
        firstField.selector,
        firstField.actionHint,
        classification,
      );
      return prepared.result ?? this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'fill_form',
        toolName: 'browser.fill_form',
        actionClass: classification.actionClass,
        decision: 'requires_user',
        outcome: 'not_run',
        requestId: `browser-${Date.now()}`,
        reason: classification.reason,
        summary: 'browser.fill_form requires user approval',
        data: null,
      });
    }

    const prepared = await this.prepareMutatingAction(
      request,
      'fill_form',
      'browser.fill_form',
      request.fields[0]!.selector,
      request.fields[0]!.actionHint,
      classification,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.recheckPreparedGrant(
      request,
      'fill_form',
      'browser.fill_form',
      prepared,
    );
    if (recheck) {
      return recheck;
    }
    try {
      await this.driver.fillForm(request.profileId, request.targetId, request.fields.map((field) => ({
        selector: field.selector,
        value: field.value,
      })));
      return this.mutationSucceeded(request, 'fill_form', 'browser.fill_form', prepared);
    } catch (error) {
      return this.mutationFailed(request, 'fill_form', 'browser.fill_form', prepared, error);
    }
  }

  async requestGrant(
    request: BrowserGatewayContext & BrowserRequestGrantRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const profile = this.profileStore.getProfile(request.profileId);
    const { target, error } = profile
      ? await this.getLiveTarget(request.profileId, request.targetId)
      : { target: null, error: undefined };
    const currentUrl = target?.url;
    if (!profile || !target || !currentUrl) {
      return this.result({
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
      return this.result({
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

    const actionClass = this.primaryActionClass(request.proposedGrant.allowedActionClasses);
    const approval = this.approvalStore.createRequest({
      instanceId: request.instanceId ?? 'unknown',
      provider: this.providerFromContext(request.provider),
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

    return this.result({
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

  async getApprovalStatus(
    request: BrowserGatewayContext & BrowserApprovalStatusRequest,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.result({
        context: request,
        action: 'get_approval_status',
        toolName: 'browser.get_approval_status',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request was not found for this instance',
        data: null,
      });
    }

    const current = this.expireApprovalIfNeeded(approval);
    return this.result({
      context: request,
      profileId: current.profileId,
      targetId: current.targetId,
      action: 'get_approval_status',
      toolName: 'browser.get_approval_status',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read Browser Gateway approval request status',
      data: current,
    });
  }

  async listApprovalRequests(
    request: BrowserGatewayContext & BrowserListApprovalRequestsRequest = {},
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest[]>> {
    const approvals = this.approvalStore.listRequests({
      instanceId: request.instanceId,
      status: request.status,
      limit: request.limit ?? 100,
    }).map((approval) => this.expireApprovalIfNeeded(approval));
    return this.result({
      context: request,
      action: 'list_approval_requests',
      toolName: 'browser.list_approval_requests',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Listed ${approvals.length} Browser Gateway approval requests`,
      data: approvals,
    });
  }

  async getApprovalRequest(
    request: BrowserGatewayContext & BrowserApprovalRequestLookup,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.result({
        context: request,
        action: 'get_approval_request',
        toolName: 'browser.get_approval_request',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request was not found',
        data: null,
      });
    }
    const current = this.expireApprovalIfNeeded(approval);
    return this.result({
      context: request,
      profileId: current.profileId,
      targetId: current.targetId,
      action: 'get_approval_request',
      toolName: 'browser.get_approval_request',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read Browser Gateway approval request',
      data: current,
    });
  }

  async approveRequest(
    request: BrowserGatewayContext & BrowserApproveRequestPayload,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.result({
        context: request,
        action: 'approve_request',
        toolName: 'browser.approve_request',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request could not be approved because it was not found',
        data: null,
      });
    }
    if (approval.status !== 'pending' || approval.expiresAt <= Date.now()) {
      const current = this.expireApprovalIfNeeded(approval);
      return this.result({
        context: request,
        profileId: approval.profileId,
        targetId: approval.targetId,
        action: 'approve_request',
        toolName: 'browser.approve_request',
        actionClass: approval.actionClass,
        decision: 'denied',
        outcome: 'not_run',
        reason: `approval_request_${current.status}`,
        summary: 'Browser approval request is no longer pending',
        data: null,
      });
    }

    const now = Date.now();
    const grant = this.grantStore.createGrant({
      ...request.grant,
      autonomous: request.grant.mode === 'autonomous' && request.grant.autonomous,
      instanceId: approval.instanceId,
      provider: approval.provider,
      profileId: approval.profileId,
      targetId: approval.targetId,
      requestedBy: approval.instanceId,
      decidedBy: 'user',
      decision: 'allow',
      reason: request.reason,
      expiresAt: this.defaultGrantExpiresAt(request.grant.mode, now),
    });
    this.approvalStore.resolveRequest(approval.requestId, {
      status: 'approved',
      grantId: grant.id,
    });

    return this.result({
      context: request,
      profileId: approval.profileId,
      targetId: approval.targetId,
      action: 'approve_request',
      toolName: 'browser.approve_request',
      actionClass: approval.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Approved Browser Gateway request and created grant',
      origin: approval.origin,
      url: approval.url,
      requestId: undefined,
      grantId: grant.id,
      autonomous: grant.autonomous,
      data: grant,
    });
  }

  async denyRequest(
    request: BrowserGatewayContext & BrowserDenyRequestPayload,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.result({
        context: request,
        action: 'deny_request',
        toolName: 'browser.deny_request',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request could not be denied because it was not found',
        data: null,
      });
    }
    const denied = this.approvalStore.resolveRequest(approval.requestId, {
      status: 'denied',
    });
    return this.result({
      context: request,
      profileId: approval.profileId,
      targetId: approval.targetId,
      action: 'deny_request',
      toolName: 'browser.deny_request',
      actionClass: approval.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Denied Browser Gateway approval request',
      origin: approval.origin,
      url: approval.url,
      data: denied,
    });
  }

  async createGrant(
    request: BrowserGatewayContext & BrowserCreateGrantRequest,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant>> {
    const now = Date.now();
    const grant = this.grantStore.createGrant({
      mode: request.mode,
      instanceId: request.instanceId,
      provider: request.provider,
      profileId: request.profileId,
      targetId: request.targetId,
      allowedOrigins: request.allowedOrigins,
      allowedActionClasses: request.allowedActionClasses,
      allowExternalNavigation: request.allowExternalNavigation,
      uploadRoots: request.uploadRoots,
      autonomous: request.mode === 'autonomous' && request.autonomous,
      requestedBy: request.requestedBy,
      decidedBy: 'user',
      decision: 'allow',
      reason: request.reason,
      expiresAt: this.capGrantExpiresAt(request.mode, request.expiresAt, now),
    });
    return this.result({
      context: request,
      profileId: grant.profileId,
      targetId: grant.targetId,
      action: 'create_grant',
      toolName: 'browser.create_grant',
      actionClass: this.primaryActionClass(grant.allowedActionClasses),
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Created Browser Gateway grant',
      grantId: grant.id,
      autonomous: grant.autonomous,
      data: grant,
    });
  }

  async listGrants(
    request: BrowserGatewayContext & BrowserListGrantsRequest = {},
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant[]>> {
    const grants = this.grantStore.listGrants({
      instanceId: request.instanceId,
      profileId: request.profileId,
      includeExpired: request.includeExpired,
      limit: request.limit ?? 100,
    });
    return this.result({
      context: request,
      profileId: request.profileId,
      action: 'list_grants',
      toolName: 'browser.list_grants',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Listed ${grants.length} Browser Gateway grants`,
      data: grants,
    });
  }

  async revokeGrant(
    request: BrowserGatewayContext & BrowserRevokeGrantRequest,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    if (request.instanceId) {
      const ownGrant = this.grantStore.listGrants({
        instanceId: request.instanceId,
        includeExpired: true,
      }).find((grant) => grant.id === request.grantId);
      if (!ownGrant) {
        return this.result({
          context: request,
          action: 'revoke_grant',
          toolName: 'browser.revoke_grant',
          actionClass: 'read',
          decision: 'denied',
          outcome: 'not_run',
          reason: 'grant_not_found_for_instance',
          summary: 'Browser grant was not found for this instance',
          data: null,
        });
      }
    }
    const revoked = this.grantStore.revokeGrant(request.grantId, request.reason);
    return this.result({
      context: request,
      profileId: revoked?.profileId,
      targetId: revoked?.targetId,
      action: 'revoke_grant',
      toolName: 'browser.revoke_grant',
      actionClass: 'read',
      decision: revoked ? 'allowed' : 'denied',
      outcome: revoked ? 'succeeded' : 'not_run',
      reason: revoked ? undefined : 'grant_not_found',
      summary: revoked ? 'Revoked Browser Gateway grant' : 'Browser grant was not found',
      grantId: revoked?.id,
      autonomous: revoked?.autonomous,
      data: revoked,
    });
  }

  private getTarget(profileId: string, targetId: string): BrowserTarget | null {
    return (
      this.targetRegistry
        .listTargets(profileId)
        .find((target) => target.id === targetId) ?? null
    );
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

  private async prepareMutatingAction(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
    selector: string,
    actionHint?: string,
    classificationOverride?: ReturnType<typeof classifyBrowserAction>,
  ): Promise<
    | {
        result: BrowserGatewayResult<null>;
      }
    | {
        result?: undefined;
        grant: ReturnType<BrowserGrantStore['listGrants']>[number];
        actionClass: BrowserActionClass;
        origin: string;
        url: string;
      }
  > {
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
        provider: this.providerFromContext(request.provider),
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
      provider: this.providerFromContext(request.provider),
      profileId: profile.id,
      targetId: target.id,
      origin: originDecision.origin,
      liveOrigin: target.origin ?? originDecision.origin,
      actionClass: classification.actionClass,
      autonomousRequired:
        classification.actionClass === 'submit' ||
        classification.actionClass === 'destructive',
    });

    if (!match.grant || classification.hardStop) {
      const approval = this.approvalStore.createRequest({
        instanceId: request.instanceId ?? 'unknown',
        provider: this.providerFromContext(request.provider),
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

  private recheckPreparedGrant(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
    prepared: {
      grant: ReturnType<BrowserGrantStore['listGrants']>[number];
      actionClass: BrowserActionClass;
      origin: string;
      url: string;
    },
  ): BrowserGatewayResult<null> | null {
    const grants = this.grantStore.listGrants({
      instanceId: request.instanceId,
      profileId: request.profileId,
    });
    const match = findMatchingBrowserGrant({
      grants,
      instanceId: request.instanceId ?? '',
      provider: this.providerFromContext(request.provider),
      profileId: request.profileId,
      targetId: request.targetId,
      origin: prepared.origin,
      liveOrigin: prepared.origin,
      actionClass: prepared.actionClass,
      autonomousRequired:
        prepared.actionClass === 'submit' ||
        prepared.actionClass === 'destructive',
    });
    if (match.grant?.id === prepared.grant.id) {
      return null;
    }

    const approval = this.approvalStore.createRequest({
      instanceId: request.instanceId ?? 'unknown',
      provider: this.providerFromContext(request.provider),
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

  private mutationSucceeded(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
    prepared: {
      grant: ReturnType<BrowserGrantStore['listGrants']>[number];
      actionClass: BrowserActionClass;
      origin: string;
      url: string;
    },
  ): BrowserGatewayResult<null> {
    if (prepared.grant.mode === 'per_action') {
      this.grantStore.consumeGrant(prepared.grant.id);
    }
    return this.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Executed ${toolName} under approved grant`,
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data: null,
    });
  }

  private mutationFailed(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
    prepared: {
      grant: ReturnType<BrowserGrantStore['listGrants']>[number];
      actionClass: BrowserActionClass;
      origin: string;
      url: string;
    },
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

  private safeExistingTabCommand(
    command: BrowserExtensionCommand,
  ): BrowserGatewayExistingTabRefresh {
    return {
      commandId: command.id,
      status: command.status,
      profileId: command.profileId,
      targetId: command.targetId,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
    };
  }

  private safeTargetFromExistingTab(
    attachment: BrowserExistingTabAttachment,
  ): ReturnType<typeof toAgentSafeTarget> {
    return toAgentSafeTarget({
      id: attachment.targetId,
      profileId: attachment.profileId,
      pageId: String(attachment.tabId),
      driverTargetId: `chrome-tab:${attachment.windowId}:${attachment.tabId}`,
      mode: 'existing-tab',
      title: attachment.title,
      url: attachment.url,
      origin: attachment.origin,
      driver: 'extension',
      status: 'selected',
      lastSeenAt: attachment.updatedAt,
    });
  }

  private snapshotExistingTab(
    request: BrowserGatewayTargetRequest,
    attachment: BrowserExistingTabAttachment,
  ): BrowserGatewayResult<(BrowserSnapshot & { text: string }) | null> {
    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Existing-tab snapshot denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: attachment.url,
        data: null,
      });
    }

    return this.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: 'snapshot',
      toolName: 'browser.snapshot',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read cached snapshot from selected existing Chrome tab',
      origin: originDecision.origin,
      url: attachment.url,
      data: {
        title: attachment.title ?? '',
        url: attachment.url,
        text: redactBrowserText(attachment.text ?? '').slice(0, 12_000),
      },
    });
  }

  private screenshotExistingTab(
    request: BrowserGatewayScreenshotRequest,
    attachment: BrowserExistingTabAttachment,
  ): BrowserGatewayResult<string | null> {
    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Existing-tab screenshot denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: attachment.url,
        data: null,
      });
    }
    if (!attachment.screenshotBase64) {
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'failed',
        reason: 'existing_tab_screenshot_unavailable',
        summary: 'Selected existing Chrome tab has no cached screenshot',
        origin: originDecision.origin,
        url: attachment.url,
        data: null,
      });
    }

    return this.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: 'screenshot',
      toolName: 'browser.screenshot',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read cached screenshot from selected existing Chrome tab',
      origin: originDecision.origin,
      url: attachment.url,
      data: attachment.screenshotBase64,
    });
  }

  private async readTargetData<T>(
    request: BrowserGatewayTargetRequest,
    action: string,
    toolName: string,
    label: string,
    read: (profileId: string, targetId: string) => Promise<T>,
  ): Promise<BrowserGatewayResult<T | null>> {
    const profile = this.profileStore.getProfile(request.profileId);
    const { target, error } = profile
      ? await this.getLiveTarget(request.profileId, request.targetId)
      : { target: null, error: undefined };
    const currentUrl = target?.url;
    if (!profile || !target || !currentUrl) {
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action,
        toolName,
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: error ?? 'profile_target_or_url_not_found',
        summary: error
          ? `${label} denied because the live browser target could not be refreshed: ${error}`
          : `${label} denied because the profile, target, or URL was not found`,
        data: null,
      });
    }

    const originDecision = isOriginAllowed(currentUrl, profile.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action,
        toolName,
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `${label} denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: currentUrl,
        data: null,
      });
    }

    try {
      const data = await read(profile.id, target.id);
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action,
        toolName,
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: `Read ${label} from allowed origin`,
        origin: originDecision.origin,
        url: currentUrl,
        data,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: profile.id,
        targetId: target.id,
        action,
        toolName,
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `${label} failed: ${message}`,
        origin: originDecision.origin,
        url: currentUrl,
        data: null,
      });
    }
  }

  private result<T>(params: {
    context: BrowserGatewayContext;
    profileId?: string;
    targetId?: string;
    action: string;
    toolName: string;
    actionClass: BrowserActionClass;
    decision: BrowserGatewayDecision;
    outcome: BrowserGatewayOutcome;
    summary: string;
    reason?: string;
    origin?: string;
    url?: string;
    data: T;
    requestId?: string;
    grantId?: string;
    autonomous?: boolean;
  }): BrowserGatewayResult<T> {
    const safeSummary = this.safeAgentString(params.summary, 2_000);
    const safeReason = params.reason
      ? this.safeAgentString(params.reason, 1_000)
      : undefined;
    const auditInput: BrowserAuditEntryInput = {
      instanceId: params.context.instanceId,
      provider: params.context.provider ?? 'orchestrator',
      profileId: params.profileId,
      targetId: params.targetId,
      action: params.action,
      toolName: params.toolName,
      actionClass: params.actionClass,
      origin: params.origin ? this.safeAgentString(params.origin, 2_000) : undefined,
      url: params.url ? this.safeAgentString(params.url, 2_000) : undefined,
      decision: params.decision,
      outcome: params.outcome,
      summary: safeSummary,
      redactionApplied: true,
      requestId: params.requestId,
      grantId: params.grantId,
      autonomous: params.autonomous,
    };
    const audit = this.auditStore.record(auditInput);
    const result = {
      decision: params.decision,
      outcome: params.outcome,
      data: params.data,
      reason: safeReason,
      auditId: audit.id,
    };
    return params.requestId
      ? { ...result, requestId: params.requestId } as BrowserGatewayResult<T>
      : result as BrowserGatewayResult<T>;
  }

  private safeAgentString(value: string, maxLength: number): string {
    return redactAgentString(value).slice(0, maxLength);
  }

  private providerFromContext(provider: string | undefined): BrowserProvider {
    return provider === 'claude' ||
      provider === 'codex' ||
      provider === 'gemini' ||
      provider === 'copilot' ||
      provider === 'orchestrator'
      ? provider
      : 'orchestrator';
  }

  private getScopedApprovalRequest(
    requestId: string,
    instanceId?: string,
  ): BrowserApprovalRequest | null {
    return this.approvalStore.getRequest(requestId, instanceId);
  }

  private expireApprovalIfNeeded(approval: BrowserApprovalRequest): BrowserApprovalRequest {
    if (approval.status !== 'pending' || approval.expiresAt > Date.now()) {
      return approval;
    }
    return this.approvalStore.resolveRequest(approval.requestId, {
      status: 'expired',
    }) ?? approval;
  }

  private primaryActionClass(classes: BrowserActionClass[]): BrowserActionClass {
    if (classes.includes('destructive')) {
      return 'destructive';
    }
    if (classes.includes('submit')) {
      return 'submit';
    }
    if (classes.includes('credential')) {
      return 'credential';
    }
    if (classes.includes('file-upload')) {
      return 'file-upload';
    }
    return classes[0] ?? 'unknown';
  }

  private defaultGrantExpiresAt(mode: BrowserGrantMode, now: number): number {
    if (mode === 'per_action') {
      return now + 30 * 60 * 1000;
    }
    return now + 8 * 60 * 60 * 1000;
  }

  private capGrantExpiresAt(mode: BrowserGrantMode, requestedExpiresAt: number, now: number): number {
    const max = mode === 'autonomous'
      ? now + 24 * 60 * 60 * 1000
      : now + 24 * 60 * 60 * 1000;
    return Math.min(requestedExpiresAt, max);
  }

  private resolveProfileRoot(profile: BrowserProfile): string {
    return profile.userDataDir ?? this.profileRegistry.resolveProfileDir(profile.id);
  }

  private proposedUploadRoots(
    currentRoots: string[] | undefined,
    resolvedFilePath: string | undefined,
  ): string[] | undefined {
    const roots = [...(currentRoots ?? [])];
    if (resolvedFilePath) {
      roots.push(path.dirname(resolvedFilePath));
    }
    return roots.length > 0 ? Array.from(new Set(roots)) : undefined;
  }
}

export function getBrowserGatewayService(): BrowserGatewayService {
  return BrowserGatewayService.getInstance();
}

export function initializeBrowserGatewayService(): BrowserGatewayService {
  return BrowserGatewayService.getInstance();
}
