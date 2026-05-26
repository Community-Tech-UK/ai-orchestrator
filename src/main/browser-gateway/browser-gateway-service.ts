import * as path from 'node:path';
import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
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
  BrowserManualStepRequest,
  BrowserPermissionGrant,
  BrowserRequestGrantRequest,
  BrowserRequestUserLoginRequest,
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
  classifyBrowserFillForm,
} from './browser-action-classifier';
import { validateBrowserUploadPath } from './browser-upload-policy';
import {
  BrowserExtensionTabStore,
  type BrowserExistingTabAttachment,
  getBrowserExtensionTabStore,
} from './browser-extension-tab-store';
import {
  BrowserExtensionCommandStore,
  getBrowserExtensionCommandStore,
  type BrowserExtensionCommandName,
} from './browser-extension-command-store';
import {
  BrowserGatewayActionGuard,
  providerFromContext,
  type BrowserGatewayResultInput,
} from './browser-gateway-action-guard';

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

export interface BrowserGatewayFindOrOpenRequest extends BrowserGatewayContext {
  url?: string;
  titleHint?: string;
}

export interface BrowserGatewayAttachExistingTabRequest
  extends BrowserGatewayContext,
    BrowserAttachExistingTabRequest {}

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
    'listProfiles' | 'getProfile' | 'updateProfile' | 'deleteProfile' | 'setRuntimeState'
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
    'attachTab' | 'getTab' | 'detachTab' | 'listTabs'
  >;
  extensionCommandStore?: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  auditStore?: Pick<BrowserAuditStore, 'record' | 'list'>;
  grantStore?: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant' | 'createGrant' | 'revokeGrant'>;
  approvalStore?: Pick<BrowserApprovalStore, 'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'>;
  healthService?: Pick<BrowserHealthService, 'diagnose'>;
}

export class BrowserGatewayService {
  private static instance: BrowserGatewayService | null = null;
  private readonly profileStore: Pick<
    BrowserProfileStore,
    'listProfiles' | 'getProfile' | 'updateProfile' | 'deleteProfile' | 'setRuntimeState'
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
    'attachTab' | 'getTab' | 'detachTab' | 'listTabs'
  >;
  private readonly extensionCommandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  private readonly auditStore: Pick<BrowserAuditStore, 'record' | 'list'>;
  private readonly grantStore: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant' | 'createGrant' | 'revokeGrant'>;
  private readonly approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'>;
  private readonly healthService: Pick<BrowserHealthService, 'diagnose'>;
  private readonly actionGuard: BrowserGatewayActionGuard;

  constructor(options: BrowserGatewayServiceOptions = {}) {
    this.profileStore = options.profileStore ?? getBrowserProfileStore();
    this.profileRegistry = options.profileRegistry ?? getBrowserProfileRegistry();
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.driver = options.driver ?? getPuppeteerBrowserDriver();
    this.extensionTabStore = options.extensionTabStore ?? getBrowserExtensionTabStore();
    this.extensionCommandStore = options.extensionCommandStore ?? getBrowserExtensionCommandStore();
    this.auditStore = options.auditStore ?? getBrowserAuditStore();
    this.grantStore = options.grantStore ?? getBrowserGrantStore();
    this.approvalStore = options.approvalStore ?? getBrowserApprovalStore();
    this.healthService = options.healthService ?? getBrowserHealthService();
    this.actionGuard = new BrowserGatewayActionGuard({
      profileStore: this.profileStore,
      targetRegistry: this.targetRegistry,
      driver: this.driver,
      extensionTabStore: this.extensionTabStore,
      grantStore: this.grantStore,
      approvalStore: this.approvalStore,
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
    });
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

  async findOrOpen(
    request: BrowserGatewayFindOrOpenRequest,
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeTarget> | null>> {
    const url = request.url?.trim();
    const titleHint = request.titleHint?.trim().toLowerCase();
    const existing = this.findExistingTabCandidate(url, titleHint);
    if (existing) {
      return this.result({
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
        data: this.safeTargetFromExistingTab(existing),
      });
    }

    if (!url) {
      return this.result({
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

    try {
      const result = await this.extensionCommandStore.sendCommand({
        command: 'open_tab',
        payload: { url },
        timeoutMs: 30_000,
      });
      const tab = this.extractTabPayload(result);
      const attachment = this.extensionTabStore.attachTab(tab);
      return this.result({
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
        data: this.safeTargetFromExistingTab(attachment),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
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
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return this.navigateExistingTab(request, existingTab);
    }

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

  async requestUserLogin(
    request: BrowserGatewayContext & BrowserRequestUserLoginRequest,
  ): Promise<BrowserGatewayResult<null>> {
    return this.createManualHandoffApproval({
      request,
      toolName: 'browser.request_user_login',
      action: 'request_user_login',
      actionClass: 'credential',
      resultReason: 'manual_login_required',
      defaultPrompt: 'User login is required before Browser Gateway automation can continue.',
      summary: 'Browser Gateway user login request requires manual completion',
    });
  }

  async pauseForManualStep(
    request: BrowserGatewayContext & BrowserManualStepRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const kind = request.kind ?? 'manual_review';
    return this.createManualHandoffApproval({
      request,
      toolName: 'browser.pause_for_manual_step',
      action: 'pause_for_manual_step',
      actionClass: this.manualStepActionClass(kind),
      resultReason: 'manual_step_required',
      defaultPrompt: this.defaultManualStepPrompt(kind),
      summary: 'Browser Gateway manual step request requires user action',
    });
  }

  async click(
    request: BrowserGatewayContext & BrowserClickRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'click',
      'browser.click',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.actionGuard.recheckPreparedGrant(request, 'click', 'browser.click', prepared);
    if (recheck) {
      return recheck;
    }

    try {
      const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
      if (existingTab) {
        await this.sendExistingTabCommand(existingTab, 'click', {
          selector: request.selector,
        });
      } else {
        await this.driver.click(request.profileId, request.targetId, request.selector);
      }
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
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'type',
      'browser.type',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.actionGuard.recheckPreparedGrant(request, 'type', 'browser.type', prepared);
    if (recheck) {
      return recheck;
    }
    try {
      const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
      if (existingTab) {
        await this.sendExistingTabCommand(existingTab, 'type', {
          selector: request.selector,
          value: request.value,
        });
      } else {
        await this.driver.type(request.profileId, request.targetId, request.selector, request.value);
      }
      return this.actionGuard.mutationSucceeded(request, 'type', 'browser.type', prepared);
    } catch (error) {
      return this.actionGuard.mutationFailed(request, 'type', 'browser.type', prepared, error);
    }
  }

  async select(
    request: BrowserGatewayContext & BrowserSelectRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'select',
      'browser.select',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.actionGuard.recheckPreparedGrant(request, 'select', 'browser.select', prepared);
    if (recheck) {
      return recheck;
    }
    try {
      const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
      if (existingTab) {
        await this.sendExistingTabCommand(existingTab, 'select', {
          selector: request.selector,
          value: request.value,
        });
      } else {
        await this.driver.select(request.profileId, request.targetId, request.selector, request.value);
      }
      return this.actionGuard.mutationSucceeded(request, 'select', 'browser.select', prepared);
    } catch (error) {
      return this.actionGuard.mutationFailed(request, 'select', 'browser.select', prepared, error);
    }
  }

  async uploadFile(
    request: BrowserGatewayContext & BrowserUploadFileRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'upload_file',
      'browser.upload_file',
      request.selector,
      request.actionHint,
    );
    if (prepared.result) {
      return prepared.result;
    }
    const recheck = this.actionGuard.recheckPreparedGrant(
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
        provider: providerFromContext(request.provider),
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
      return this.actionGuard.mutationSucceeded(request, 'upload_file', 'browser.upload_file', prepared);
    } catch (error) {
      return this.actionGuard.mutationFailed(request, 'upload_file', 'browser.upload_file', prepared, error);
    }
  }

  async fillForm(
    request: BrowserGatewayContext & BrowserFillFormRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const firstField = request.fields[0]!;
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      const prepared = await this.actionGuard.prepareMutatingAction(
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
      if (prepared.result) {
        return prepared.result;
      }
      const recheck = this.actionGuard.recheckPreparedGrant(
        request,
        'fill_form',
        'browser.fill_form',
        prepared,
      );
      if (recheck) {
        return recheck;
      }
      try {
        await this.sendExistingTabCommand(existingTab, 'fill_form', {
          fields: request.fields,
        });
        return this.actionGuard.mutationSucceeded(request, 'fill_form', 'browser.fill_form', prepared);
      } catch (error) {
        return this.actionGuard.mutationFailed(request, 'fill_form', 'browser.fill_form', prepared, error);
      }
    }

    const gate = await this.actionGuard.prepareMutatingAction(
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
        const prepared = await this.actionGuard.prepareMutatingAction(
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
      const prepared = await this.actionGuard.prepareMutatingAction(
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

    const prepared = await this.actionGuard.prepareMutatingAction(
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
    const recheck = this.actionGuard.recheckPreparedGrant(
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
      return this.actionGuard.mutationSucceeded(request, 'fill_form', 'browser.fill_form', prepared);
    } catch (error) {
      return this.actionGuard.mutationFailed(request, 'fill_form', 'browser.fill_form', prepared, error);
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
    if (approval.toolName === 'browser.request_user_login') {
      try {
        if (this.profileStore.getProfile(approval.profileId)) {
          this.profileStore.setRuntimeState(approval.profileId, {
            lastLoginCheckAt: now,
          });
        }
      } catch {
        // Existing-tab login handoffs do not have managed profile runtime state.
      }
    }

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

  private async createManualHandoffApproval(params: {
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
      return this.result({
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
    const approval = this.approvalStore.createRequest({
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

    return this.result({
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
      const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
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

    const profile = this.profileStore.getProfile(request.profileId);
    if (!profile) {
      return { error: 'profile_not_found' };
    }

    const { target, error } = request.targetId
      ? await this.getLiveTarget(request.profileId, request.targetId)
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

  private manualStepActionClass(kind: BrowserManualStepRequest['kind']): BrowserActionClass {
    return kind === 'login' || kind === 'captcha' || kind === 'two_factor'
      ? 'credential'
      : 'unknown';
  }

  private defaultManualStepPrompt(kind: BrowserManualStepRequest['kind']): string {
    if (kind === 'login') {
      return 'User login is required before Browser Gateway automation can continue.';
    }
    if (kind === 'captcha') {
      return 'Complete the browser CAPTCHA challenge before Browser Gateway automation continues.';
    }
    if (kind === 'two_factor') {
      return 'Complete the browser two-factor authentication step before Browser Gateway automation continues.';
    }
    return 'Manual browser review is required before Browser Gateway automation can continue.';
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

  private findExistingTabCandidate(
    url: string | undefined,
    titleHint: string | undefined,
  ): BrowserExistingTabAttachment | null {
    const tabs = this.extensionTabStore.listTabs();
    const parsedUrl = url ? this.tryParseWebUrl(url) : null;

    if (parsedUrl && url) {
      const exactOrPrefix = tabs.find((tab) =>
        tab.url === url || tab.url.startsWith(url),
      );
      if (exactOrPrefix) {
        return exactOrPrefix;
      }
      const sameOrigin = tabs.find((tab) => tab.origin === parsedUrl.origin);
      if (sameOrigin) {
        return sameOrigin;
      }
    }

    if (titleHint) {
      return tabs.find((tab) =>
        (tab.title ?? '').toLowerCase().includes(titleHint),
      ) ?? null;
    }

    return null;
  }

  private tryParseWebUrl(url: string): URL | null {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private async navigateExistingTab(
    request: BrowserGatewayNavigateRequest,
    attachment: BrowserExistingTabAttachment,
  ): Promise<BrowserGatewayResult<null>> {
    const originDecision = isOriginAllowed(request.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Existing Chrome tab navigation denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: request.url,
        data: null,
      });
    }

    try {
      const result = await this.sendExistingTabCommand(attachment, 'navigate', {
        url: request.url,
      });
      if (result) {
        try {
          const tab = this.extractTabPayload(result);
          this.extensionTabStore.attachTab(tab);
        } catch {
          // Navigation succeeded; stale metadata is less important than
          // preserving the audited command result.
        }
      }
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Navigated existing Chrome tab within allowed origin',
        origin: originDecision.origin,
        url: request.url,
        data: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Existing Chrome tab navigation failed: ${message}`,
        origin: originDecision.origin,
        url: request.url,
        data: null,
      });
    }
  }

  private async sendExistingTabCommand(
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.extensionCommandStore.sendCommand({
      command,
      target: {
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        tabId: attachment.tabId,
        windowId: attachment.windowId,
      },
      ...(payload ? { payload } : {}),
      timeoutMs: 30_000,
    });
  }

  private extractTabPayload(result: unknown): BrowserAttachExistingTabRequest {
    const value = this.isRecord(result) && this.isRecord(result['tab'])
      ? result['tab']
      : result;
    if (!this.isRecord(value)) {
      throw new Error('browser_extension_tab_result_invalid');
    }
    const tabId = value['tabId'];
    const windowId = value['windowId'];
    const url = value['url'];
    if (
      typeof tabId !== 'number' ||
      typeof windowId !== 'number' ||
      typeof url !== 'string'
    ) {
      throw new Error('browser_extension_tab_result_invalid');
    }
    return {
      tabId,
      windowId,
      url,
      ...(typeof value['title'] === 'string' ? { title: value['title'] } : {}),
      ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}),
      ...(typeof value['screenshotBase64'] === 'string'
        ? { screenshotBase64: value['screenshotBase64'] }
        : {}),
      ...(typeof value['capturedAt'] === 'number' ? { capturedAt: value['capturedAt'] } : {}),
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
