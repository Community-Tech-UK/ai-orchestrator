import * as path from 'node:path';
import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserApprovalRequest,
  BrowserApprovalRequestLookup,
  BrowserApprovalStatusRequest,
  BrowserApproveRequestPayload,
  BrowserAuditEntry,
  BrowserClickRequest,
  BrowserCreateGrantRequest,
  BrowserDenyRequestPayload,
  BrowserDownloadFileRequest,
  BrowserDownloadFileResult,
  BrowserElementCandidate,
  BrowserFillFormRequest,
  BrowserGatewayResult,
  BrowserListApprovalRequestsRequest,
  BrowserListGrantsRequest,
  BrowserManualStepRequest,
  BrowserPermissionGrant,
  BrowserRequestGrantRequest,
  BrowserRequestUserLoginRequest,
  BrowserRevokeGrantRequest,
  BrowserQueryElementsRequest,
  BrowserSelectRequest,
  BrowserProfile,
  BrowserTypeRequest,
  BrowserUploadFileRequest,
  BrowserTarget,
} from '@contracts/types/browser';
import { BrowserAuditStore, getBrowserAuditStore } from './browser-audit-store';
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
} from './browser-extension-command-store';
import {
  BrowserGatewayActionGuard,
  providerFromContext,
} from './browser-gateway-action-guard';
import { autoApproveBrowserApproval } from './browser-auto-approve';
import {
  defaultManualStepPrompt,
  extractTabPayload,
  manualStepActionClass,
  primaryActionClass,
  proposedUploadRoots,
  safeTargetFromExistingTab,
  tryParseWebUrl,
} from './browser-gateway-service-helpers';
import {
  BrowserGatewayResultRecorder,
  type BrowserGatewayResultInput,
} from './browser-gateway-result';
import {
  BrowserExistingTabOperations,
  normalizeDownloadFileResult,
} from './browser-existing-tab-operations';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import { normalizeElementCandidates } from './browser-element-candidates';
import type {
  BrowserGatewayAttachExistingTabRequest,
  BrowserGatewayAuditLogRequest,
  BrowserGatewayContext,
  BrowserGatewayCreateProfileRequest,
  BrowserGatewayFindOrOpenRequest,
  BrowserGatewayListTargetsRequest,
  BrowserGatewayMutatingActionRequest,
  BrowserGatewayNavigateRequest,
  BrowserGatewayScreenshotRequest,
  BrowserGatewayServiceOptions,
  BrowserGatewayTargetRequest,
  BrowserGatewayUpdateProfileRequest,
} from './browser-gateway-service-types';

export type {
  BrowserGatewayAttachExistingTabRequest,
  BrowserGatewayAuditLogRequest,
  BrowserGatewayContext,
  BrowserGatewayCreateProfileRequest,
  BrowserGatewayFindOrOpenRequest,
  BrowserGatewayListTargetsRequest,
  BrowserGatewayMutatingActionRequest,
  BrowserGatewayNavigateRequest,
  BrowserGatewayScreenshotRequest,
  BrowserGatewayServiceOptions,
  BrowserGatewayTargetRequest,
  BrowserGatewayUpdateProfileRequest,
} from './browser-gateway-service-types';

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
    | 'queryElements'
    | 'inspectElement'
    | 'click'
    | 'type'
    | 'fillForm'
    | 'select'
    | 'uploadFile'
    | 'downloadFile'
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
  private readonly autoApproveRequests?: BrowserGatewayServiceOptions['autoApproveRequests'];
  private readonly resolvePreferredDebugPort?: BrowserGatewayServiceOptions['resolvePreferredDebugPort'];
  private readonly actionGuard: BrowserGatewayActionGuard;
  private readonly resultRecorder: BrowserGatewayResultRecorder;
  private readonly existingTabOperations: BrowserExistingTabOperations;
  private readonly approvalOperations: BrowserGatewayApprovalOperations;

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
    this.autoApproveRequests = options.autoApproveRequests;
    this.resolvePreferredDebugPort = options.resolvePreferredDebugPort;
    this.resultRecorder = new BrowserGatewayResultRecorder(this.auditStore);
    this.existingTabOperations = new BrowserExistingTabOperations({
      extensionCommandStore: this.extensionCommandStore,
      extensionTabStore: this.extensionTabStore,
      grantStore: this.grantStore,
      approvalStore: this.approvalStore,
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
      autoApproveApproval: (approval) => this.autoApproveApproval(approval),
    });
    this.approvalOperations = new BrowserGatewayApprovalOperations({
      approvalStore: this.approvalStore,
      grantStore: this.grantStore,
      profileStore: this.profileStore,
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
    });
    this.actionGuard = new BrowserGatewayActionGuard({
      profileStore: this.profileStore,
      targetRegistry: this.targetRegistry,
      driver: this.driver,
      extensionTabStore: this.extensionTabStore,
      grantStore: this.grantStore,
      approvalStore: this.approvalStore,
      autoApproveRequests: this.autoApproveRequests,
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
    });
  }

  static getInstance(): BrowserGatewayService {
    if (!this.instance) {
      this.instance = new BrowserGatewayService();
    }
    return this.instance;
  }

  static initialize(options: BrowserGatewayServiceOptions = {}): BrowserGatewayService {
    if (!this.instance) {
      this.instance = new BrowserGatewayService(options);
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
      ? 'no_managed_profiles_configured_use_browser_find_or_open_or_share_current_tab'
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
        ? 'No managed Browser Gateway profiles are configured; use browser.find_or_open or ask the user to share the current Chrome tab through the Browser Gateway extension.'
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
        data: safeTargetFromExistingTab(attachment),
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
      const preferredDebugPort = this.resolvePreferredDebugPort?.(profile.id);
      const targets = await this.driver.openProfile(
        {
          ...profile,
          userDataDir: profile.userDataDir ?? this.profileRegistry.resolveProfileDir(profile.id),
        },
        profile.defaultUrl,
        preferredDebugPort,
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
        data: safeTargetFromExistingTab(existing),
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
      const tab = extractTabPayload(result);
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
        data: safeTargetFromExistingTab(attachment),
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
      return this.existingTabOperations.navigate(request, existingTab);
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
      return this.existingTabOperations.snapshot(request, existingTab);
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
      return this.existingTabOperations.screenshot(request, existingTab);
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
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      const originDecision = isOriginAllowed(existingTab.url, existingTab.allowedOrigins);
      if (!originDecision.allowed) {
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'wait_for',
          toolName: 'browser.wait_for',
          actionClass: 'read',
          decision: 'denied',
          outcome: 'not_run',
          reason: originDecision.reason,
          summary: `Existing-tab wait condition denied by Browser Gateway origin policy: ${originDecision.reason}`,
          url: existingTab.url,
          data: null,
        });
      }

      try {
        await this.existingTabOperations.sendCommand(
          existingTab,
          'wait_for',
          { selector, timeoutMs },
          timeoutMs,
        );
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'wait_for',
          toolName: 'browser.wait_for',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'succeeded',
          summary: 'Waited for selector in selected existing Chrome tab',
          origin: originDecision.origin,
          url: existingTab.url,
          data: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'wait_for',
          toolName: 'browser.wait_for',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'failed',
          reason: message,
          summary: `Existing-tab wait condition failed: ${message}`,
          origin: originDecision.origin,
          url: existingTab.url,
          data: null,
        });
      }
    }

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

  async queryElements(
    request: BrowserGatewayContext & BrowserQueryElementsRequest,
  ): Promise<BrowserGatewayResult<BrowserElementCandidate[] | null>> {
    const limit = request.limit ?? 50;
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      const originDecision = isOriginAllowed(existingTab.url, existingTab.allowedOrigins);
      if (!originDecision.allowed) {
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'query_elements',
          toolName: 'browser.query_elements',
          actionClass: 'read',
          decision: 'denied',
          outcome: 'not_run',
          reason: originDecision.reason,
          summary: `Existing-tab element query denied by Browser Gateway origin policy: ${originDecision.reason}`,
          url: existingTab.url,
          data: null,
        });
      }

      try {
        const data = normalizeElementCandidates(
          await this.existingTabOperations.sendCommand(existingTab, 'query_elements', {
            ...(request.query ? { query: request.query } : {}),
            limit,
          }),
        );
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'query_elements',
          toolName: 'browser.query_elements',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'succeeded',
          summary: `Read ${data.length} selector candidates from selected existing Chrome tab`,
          origin: originDecision.origin,
          url: existingTab.url,
          data,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'query_elements',
          toolName: 'browser.query_elements',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'failed',
          reason: message,
          summary: `Existing-tab element query failed: ${message}`,
          origin: originDecision.origin,
          url: existingTab.url,
          data: null,
        });
      }
    }

    return this.readTargetData(
      request,
      'query_elements',
      'browser.query_elements',
      'selector candidates',
      (profileId, targetId) => this.driver.queryElements(
        profileId,
        targetId,
        request.query,
        limit,
      ),
    );
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
      actionClass: manualStepActionClass(kind),
      resultReason: 'manual_step_required',
      defaultPrompt: defaultManualStepPrompt(kind),
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
        await this.existingTabOperations.sendCommand(existingTab, 'click', {
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
        await this.existingTabOperations.sendCommand(existingTab, 'type', {
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
        await this.existingTabOperations.sendCommand(existingTab, 'select', {
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
    let prepared = await this.actionGuard.prepareMutatingAction(
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
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    const profile = this.profileStore.getProfile(request.profileId);
    if (existingTab) {
      const uploadDecision = validateBrowserUploadPath({
        filePath: request.filePath,
        workspaceRoots: [],
        approvedRoots: prepared.grant.uploadRoots ?? [],
        userDataPath: this.placeholderExistingTabProfileRoot(request.filePath),
        profileRoot: this.placeholderExistingTabProfileRoot(request.filePath),
        autonomous: prepared.grant.autonomous,
      });
      if (!uploadDecision.allowed) {
        return this.result({
          context: request,
          profileId: request.profileId,
          targetId: request.targetId,
          action: 'upload_file',
          toolName: 'browser.upload_file',
          actionClass: 'file-upload',
          decision: 'requires_user',
          outcome: 'not_run',
          requestId: `browser-${Date.now()}`,
          reason: uploadDecision.reason,
          summary: `browser.upload_file requires user approval: ${uploadDecision.reason}`,
          origin: prepared.origin,
          url: prepared.url,
          data: null,
        });
      }
      try {
        await this.existingTabOperations.sendCommand(existingTab, 'upload_file', {
          selector: request.selector,
          filePath: uploadDecision.resolvedPath ?? request.filePath,
        });
        return this.actionGuard.mutationSucceeded(request, 'upload_file', 'browser.upload_file', prepared);
      } catch (error) {
        return this.actionGuard.mutationFailed(request, 'upload_file', 'browser.upload_file', prepared, error);
      }
    }

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
      const uploadRoots = proposedUploadRoots(
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
      const autoGrant = this.autoApproveApproval(approval);
      if (autoGrant) {
        prepared = {
          grant: autoGrant,
          actionClass: 'file-upload',
          origin: prepared.origin,
          url: prepared.url,
        };
      } else {
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

  async downloadFile(
    request: BrowserGatewayContext & BrowserDownloadFileRequest,
  ): Promise<BrowserGatewayResult<BrowserDownloadFileResult | null>> {
    const selector = request.selector ?? 'body';
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'download_file',
      'browser.download_file',
      selector,
      request.actionHint,
      {
        actionClass: 'file-download',
        hardStop: false,
      },
    );
    if (prepared.result) {
      return prepared.result as BrowserGatewayResult<BrowserDownloadFileResult | null>;
    }
    const recheck = this.actionGuard.recheckPreparedGrant(
      request,
      'download_file',
      'browser.download_file',
      prepared,
    );
    if (recheck) {
      return recheck as BrowserGatewayResult<BrowserDownloadFileResult | null>;
    }
    if (request.url) {
      const downloadOriginDecision = isOriginAllowed(
        request.url,
        prepared.grant.allowedOrigins,
      );
      if (!downloadOriginDecision.allowed) {
        return this.result({
          context: request,
          profileId: request.profileId,
          targetId: request.targetId,
          action: 'download_file',
          toolName: 'browser.download_file',
          actionClass: 'file-download',
          decision: 'denied',
          outcome: 'not_run',
          reason: 'download_url_origin_not_allowed',
          summary: `browser.download_file denied because the direct download URL is outside the approved grant origins: ${downloadOriginDecision.reason}`,
          origin: prepared.origin,
          url: request.url,
          grantId: prepared.grant.id,
          autonomous: prepared.grant.autonomous,
          data: null,
        });
      }
    }

    try {
      const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
      const download = existingTab
        ? normalizeDownloadFileResult(await this.existingTabOperations.sendCommand(existingTab, 'download_file', {
          ...(request.selector ? { selector: request.selector } : {}),
          ...(request.url ? { url: request.url } : {}),
          ...(request.suggestedFilename ? { suggestedFilename: request.suggestedFilename } : {}),
          timeoutMs: request.timeoutMs ?? 60_000,
        }, request.timeoutMs ?? 60_000))
        : await this.driver.downloadFile(request.profileId, request.targetId, {
          ...(request.selector ? { selector: request.selector } : {}),
          ...(request.url ? { url: request.url } : {}),
          timeoutMs: request.timeoutMs ?? 60_000,
        });

      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'download_file',
        toolName: 'browser.download_file',
        actionClass: prepared.actionClass,
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'browser.download_file completed under approved grant',
        origin: prepared.origin,
        url: prepared.url,
        grantId: prepared.grant.id,
        autonomous: prepared.grant.autonomous,
        data: download,
      });
    } catch (error) {
      const failed = this.actionGuard.mutationFailed(
        request,
        'download_file',
        'browser.download_file',
        prepared,
        error,
      );
      return failed as BrowserGatewayResult<BrowserDownloadFileResult | null>;
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
        await this.existingTabOperations.sendCommand(existingTab, 'fill_form', {
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
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return this.requestGrantForExistingTab(request, existingTab);
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

    const actionClass = primaryActionClass(request.proposedGrant.allowedActionClasses);
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
    const autoGrant = this.autoApproveApproval(approval);
    if (autoGrant) {
      return this.result({
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

  private async requestGrantForExistingTab(
    request: BrowserGatewayContext & BrowserRequestGrantRequest,
    attachment: BrowserExistingTabAttachment,
  ): Promise<BrowserGatewayResult<null>> {
    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.result({
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
    const approval = this.approvalStore.createRequest({
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
    const autoGrant = this.autoApproveApproval(approval);
    if (autoGrant) {
      return this.result({
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

    return this.result({
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

  async getApprovalStatus(
    request: BrowserGatewayContext & BrowserApprovalStatusRequest,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    return this.approvalOperations.getApprovalStatus(request);
  }

  async listApprovalRequests(
    request: BrowserGatewayContext & BrowserListApprovalRequestsRequest = {},
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest[]>> {
    return this.approvalOperations.listApprovalRequests(request);
  }

  async getApprovalRequest(
    request: BrowserGatewayContext & BrowserApprovalRequestLookup,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    return this.approvalOperations.getApprovalRequest(request);
  }

  async approveRequest(
    request: BrowserGatewayContext & BrowserApproveRequestPayload,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    return this.approvalOperations.approveRequest(request);
  }

  async denyRequest(
    request: BrowserGatewayContext & BrowserDenyRequestPayload,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    return this.approvalOperations.denyRequest(request);
  }

  async createGrant(
    request: BrowserGatewayContext & BrowserCreateGrantRequest,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant>> {
    return this.approvalOperations.createGrant(request);
  }

  async listGrants(
    request: BrowserGatewayContext & BrowserListGrantsRequest = {},
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant[]>> {
    return this.approvalOperations.listGrants(request);
  }

  async revokeGrant(
    request: BrowserGatewayContext & BrowserRevokeGrantRequest,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    return this.approvalOperations.revokeGrant(request);
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
    const parsedUrl = url ? tryParseWebUrl(url) : null;

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

  private result<T>(params: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> {
    return this.resultRecorder.record(params);
  }

  private autoApproveApproval(approval: BrowserApprovalRequest): BrowserPermissionGrant | null {
    return autoApproveBrowserApproval({
      approval,
      approvalStore: this.approvalStore,
      grantStore: this.grantStore,
      autoApproveRequests: this.autoApproveRequests,
    });
  }

  private resolveProfileRoot(profile: BrowserProfile): string {
    return profile.userDataDir ?? this.profileRegistry.resolveProfileDir(profile.id);
  }

  private placeholderExistingTabProfileRoot(filePath: string): string {
    const root = path.parse(path.resolve(filePath)).root;
    return path.join(root, '.aio-browser-gateway-existing-tab-profile');
  }
}

export function getBrowserGatewayService(): BrowserGatewayService {
  return BrowserGatewayService.getInstance();
}

export function initializeBrowserGatewayService(
  options: BrowserGatewayServiceOptions = {},
): BrowserGatewayService {
  return BrowserGatewayService.initialize(options);
}
