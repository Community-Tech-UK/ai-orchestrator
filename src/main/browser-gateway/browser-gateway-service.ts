import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type {
  BrowserAccessibilityNode,
  BrowserAccessibilitySnapshotRequest,
  BrowserApprovalRequest,
  BrowserApprovalRequestLookup,
  BrowserApprovalStatusRequest,
  BrowserApproveRequestPayload,
  BrowserAuditEntry,
  BrowserClickRequest,
  BrowserControlVerifyExpectation,
  BrowserCreateGrantRequest,
  BrowserDenyRequestPayload,
  BrowserDownloadFileRequest,
  BrowserDownloadFileResult,
  BrowserElementCandidate,
  BrowserEvaluateRequest,
  BrowserEvaluateResult,
  BrowserAssertPersistedRequest,
  BrowserFillFormRequest,
  BrowserGatewayResult,
  BrowserWriteJournalRequest,
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
import { getBrowserCampaignRuntime } from './browser-campaign-runtime';
import { getBrowserReliabilityEvents } from './browser-reliability-events';
import { getBrowserTargetPersistenceSentinel } from './browser-target-persistence-sentinel';
import { getBrowserWriteJournal, type BrowserWriteJournalEntry } from './browser-write-journal';
import type { BrowserAssertPersistedData } from './browser-assert-persisted-operation';
import {
  assertPersistedOperation,
  writeJournalListOperation,
  type BrowserReliabilityOperationDeps,
} from './browser-reliability-operations';
import { getBrowserEscalationService } from './browser-unattended-services';
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
  boundBrowserText,
  redactBrowserNetworkRequests,
  redactBrowserText,
  redactElementContext,
} from './browser-redaction';
import {
  normalizeAccessibilityNodes,
  normalizeEvaluateResult,
} from './browser-gateway-normalizers';
import { readBrowserTargetData } from './browser-gateway-read-target-data';
import { BrowserManualHandoffOperations } from './browser-manual-handoff-operations';
import {
  classifyBrowserFillForm,
} from './browser-action-classifier';
import {
  validateBrowserUploadPath,
  type BrowserUploadPolicyResult,
} from './browser-upload-policy';
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
  getBrowserExtensionContactState,
  type BrowserExtensionContactStateReader,
} from './browser-extension-contact-state';
import {
  isRemoteExtensionContactFresh,
  remoteExtensionContactSummary,
} from './browser-extension-node-contact';
import {
  BrowserGatewayActionGuard,
  providerFromContext,
  type BrowserGatewayPreparedMutation,
} from './browser-gateway-action-guard';
import { autoApproveBrowserApproval } from './browser-auto-approve';
import { HEAVY_DOM_COMMAND_TIMEOUT_MS } from './browser-mutation-safety';
import {
  defaultManualStepPrompt,
  extractTabPayload,
  manualStepActionClass,
  primaryActionClass,
  proposedUploadRoots,
  safeTargetFromExistingTab,
  tryParseWebUrl,
} from './browser-gateway-service-helpers';
import { existingTabGrantNodeId } from './browser-grant-scope';
import {
  BrowserGatewayResultRecorder,
  type BrowserGatewayResultInput,
} from './browser-gateway-result';
import {
  BrowserExistingTabOperations,
  normalizeDownloadFileResult,
} from './browser-existing-tab-operations';
import {
  readExistingTabConsoleMessages,
  readExistingTabNetworkRequests,
} from './browser-existing-tab-capture';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import { normalizeElementCandidates } from './browser-element-candidates';
import {
  browserActionTargetLabel,
  browserActionTargetPayload,
  browserFillFieldTargetLabel,
  placeholderExistingTabProfileRoot,
} from './browser-gateway-target-utils';
import type {
  BrowserGatewayAttachExistingTabRequest,
  BrowserGatewayAuditLogRequest,
  BrowserGatewayContext,
  BrowserGatewayCreateProfileRequest,
  BrowserGatewayCreateAgentCredentialRequest,
  BrowserGatewayExecuteFillPlanRequest,
  BrowserGatewayFillCredentialRequest,
  BrowserGatewayFillSecretRequest,
  BrowserGatewayFindOrOpenRequest,
  BrowserGatewayListTargetsRequest,
  BrowserGatewayMutatingActionRequest,
  BrowserGatewayNavigateRequest,
  BrowserGatewayScreenshotRequest,
  BrowserGatewayServiceOptions,
  BrowserGatewaySnapshotRequest,
  BrowserGatewayTargetRequest,
  BrowserGatewayUpdateProfileRequest,
} from './browser-gateway-service-types';
import { maybeExtractPageText } from './browser-aux-extraction';
import type { FillControlReadback, FillPlanResult } from './browser-fill-plan-executor';
import {
  executeFillPlanOperation,
  fillCredentialOperation,
  createAgentCredentialOperation,
  type FillOperationDeps,
} from './browser-form-fill-operations';
import { fillSecretOperation } from './browser-secret-fill-operation';
import {
  normalizeExistingTabControlReadback,
  verifyGatewayFillFormReadback,
  verifyGatewayMutationReadback,
  type BrowserGatewayMutationReadbackDeps,
} from './browser-gateway-mutation-readback';
import {
  appendBrowserUploadRecoveryHint,
  basenameForUploadPath,
  verifyUploadedFileSelection,
} from './browser-upload-verify';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { stageBrowserUploadOnNode } from './browser-remote-upload-staging';
import { BrowserTargetDiscoveryOperations } from './browser-target-discovery-operations';

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
  BrowserGatewaySnapshotRequest,
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
    | 'accessibilitySnapshot'
    | 'evaluate'
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
    | 'readControl'
    | 'setChecked'
    | 'uploadFile'
    | 'downloadFile'
  >;
  private readonly extensionTabStore: Pick<
    BrowserExtensionTabStore,
    'attachTab' | 'getTab' | 'detachTab' | 'listTabs'
  >;
  private readonly extensionCommandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  private readonly extensionContactState: BrowserExtensionContactStateReader;
  private readonly auditStore: Pick<BrowserAuditStore, 'record' | 'list'>;
  private readonly grantStore: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant' | 'createGrant' | 'revokeGrant'>;
  private readonly approvalStore: Pick<BrowserApprovalStore, 'createRequest' | 'getRequest' | 'listRequests' | 'resolveRequest'>;
  private readonly healthService: Pick<BrowserHealthService, 'diagnose'>;
  private readonly credentialVault?: BrowserGatewayServiceOptions['credentialVault'];
  private readonly credentialAuthorizations?: BrowserGatewayServiceOptions['credentialAuthorizations'];
  private readonly emailCodeReader?: BrowserGatewayServiceOptions['emailCodeReader'];
  private readonly allowSharedTabCredentialFill: (profileId: string) => boolean;
  private autoApproveRequests?: BrowserGatewayServiceOptions['autoApproveRequests'];
  private resolvePreferredDebugPort?: BrowserGatewayServiceOptions['resolvePreferredDebugPort'];
  private stageUploadFileOnNode: NonNullable<BrowserGatewayServiceOptions['stageUploadFileOnNode']>;
  private readonly actionGuard: BrowserGatewayActionGuard;
  private readonly resultRecorder: BrowserGatewayResultRecorder;
  private readonly persistenceSentinel: BrowserGatewayServiceOptions['persistenceSentinel'];
  private readonly writeJournal: BrowserGatewayServiceOptions['writeJournal'];
  private readonly reliabilityEvents: NonNullable<BrowserGatewayServiceOptions['reliabilityEvents']>;
  private readonly existingTabOperations: BrowserExistingTabOperations;
  private readonly targetDiscoveryOperations: BrowserTargetDiscoveryOperations;
  private readonly approvalOperations: BrowserGatewayApprovalOperations;
  private readonly manualHandoffOperations: BrowserManualHandoffOperations;

  constructor(options: BrowserGatewayServiceOptions = {}) {
    this.profileStore = options.profileStore ?? getBrowserProfileStore();
    this.profileRegistry = options.profileRegistry ?? getBrowserProfileRegistry();
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.driver = options.driver ?? getPuppeteerBrowserDriver();
    this.extensionTabStore = options.extensionTabStore ?? getBrowserExtensionTabStore();
    this.extensionCommandStore = options.extensionCommandStore ?? getBrowserExtensionCommandStore();
    this.extensionContactState = options.extensionContactState ?? getBrowserExtensionContactState();
    this.auditStore = options.auditStore ?? getBrowserAuditStore();
    this.grantStore = options.grantStore ?? getBrowserGrantStore();
    this.approvalStore = options.approvalStore ?? getBrowserApprovalStore();
    this.healthService = options.healthService ?? getBrowserHealthService();
    this.credentialVault = options.credentialVault;
    this.credentialAuthorizations = options.credentialAuthorizations;
    this.emailCodeReader = options.emailCodeReader;
    // Default false: shared-tab credential fills stay managed-only unless the
    // app root wires the operator opt-in setting in.
    this.allowSharedTabCredentialFill = options.allowSharedTabCredentialFill ?? (() => false);
    this.autoApproveRequests = options.autoApproveRequests;
    this.resolvePreferredDebugPort = options.resolvePreferredDebugPort;
    this.stageUploadFileOnNode = options.stageUploadFileOnNode ?? stageBrowserUploadOnNode;
    this.resultRecorder = new BrowserGatewayResultRecorder(this.auditStore);
    // Reliability hardening: `null` disables (test fakes); undefined = singletons.
    this.persistenceSentinel = options.persistenceSentinel === undefined
      ? getBrowserTargetPersistenceSentinel()
      : options.persistenceSentinel;
    this.writeJournal = options.writeJournal === undefined
      ? getBrowserWriteJournal()
      : options.writeJournal;
    this.reliabilityEvents = options.reliabilityEvents ?? getBrowserReliabilityEvents();
    this.existingTabOperations = new BrowserExistingTabOperations({
      extensionCommandStore: this.extensionCommandStore,
      extensionTabStore: this.extensionTabStore,
      isRemoteExtensionContactFresh: (nodeId) => isRemoteExtensionContactFresh(nodeId, { extensionContactState: this.extensionContactState }),
      describeRemoteExtensionContact: (nodeId) =>
        remoteExtensionContactSummary(nodeId, { extensionContactState: this.extensionContactState }),
      grantStore: this.grantStore,
      approvalStore: this.approvalStore,
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
      autoApproveApproval: (approval) => this.autoApproveApproval(approval),
      onNavigateSucceeded: (request) => getBrowserCampaignRuntime()?.recordNavigation(request),
      ...(this.persistenceSentinel ? { persistenceSentinel: this.persistenceSentinel } : {}),
      ...(this.writeJournal ? { writeJournal: this.writeJournal } : {}),
      getLastChannelDisconnectAt: (nodeId) =>
        this.extensionContactState.getLastDisconnect?.(nodeId ?? 'local')?.at,
      reliabilityEvents: this.reliabilityEvents,
    });
    this.targetDiscoveryOperations = new BrowserTargetDiscoveryOperations({
      targetRegistry: this.targetRegistry,
      driver: this.driver,
      extensionTabStore: this.extensionTabStore,
      extensionCommandStore: this.extensionCommandStore,
      extensionContactState: this.extensionContactState,
      getWorkerNodes: () => getWorkerNodeRegistry().getAllNodes(),
      getWorkerNode: (nodeId) => getWorkerNodeRegistry().getNode(nodeId),
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
    });
    this.manualHandoffOperations = new BrowserManualHandoffOperations({
      approvalStore: this.approvalStore,
      extensionTabStore: this.extensionTabStore,
      profileStore: this.profileStore,
      getLiveTarget: (profileId, targetId) => this.getLiveTarget(profileId, targetId),
      autoApproveApproval: (approval) => this.autoApproveApproval(approval),
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
    });
    this.approvalOperations = new BrowserGatewayApprovalOperations({
      approvalStore: this.approvalStore,
      grantStore: this.grantStore,
      profileStore: this.profileStore,
      autoApproveApproval: (approval) => this.autoApproveApproval(approval),
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
    });
    this.actionGuard = new BrowserGatewayActionGuard({
      profileStore: this.profileStore,
      targetRegistry: this.targetRegistry,
      driver: this.driver,
      extensionTabStore: this.extensionTabStore,
      grantStore: this.grantStore,
      approvalStore: this.approvalStore,
      autoApproveRequests: (request) => Boolean(this.autoApproveRequests?.(request)),
      escalations: { raise: (input) => getBrowserEscalationService().raise(input) },
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
      // Campaign budget enforcement: count every mutation executed under a
      // campaign lease; a tripped budget pauses the campaign + revokes leases.
      onGrantedMutation: (info) => getBrowserCampaignRuntime()?.recordGrantedMutation(info),
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
    } else {
      this.instance.configure(options);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private configure(options: BrowserGatewayServiceOptions = {}): void {
    if (options.autoApproveRequests) {
      this.autoApproveRequests = options.autoApproveRequests;
    }
    if (options.resolvePreferredDebugPort) {
      this.resolvePreferredDebugPort = options.resolvePreferredDebugPort;
    }
    if (options.stageUploadFileOnNode) {
      this.stageUploadFileOnNode = options.stageUploadFileOnNode;
    }
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
    const { instanceId, provider, nodeId, nodeName, ...input } = request;
    try {
      const attachment = this.extensionTabStore.attachTab(input, { nodeId, nodeName });
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
    return this.targetDiscoveryOperations.listTargets(request);
  }

  async findOrOpen(
    request: BrowserGatewayFindOrOpenRequest,
  ): Promise<BrowserGatewayResult<ReturnType<typeof toAgentSafeTarget> | null>> {
    return this.targetDiscoveryOperations.findOrOpen(request);
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
      getBrowserCampaignRuntime()?.recordNavigation(request);
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
    request: BrowserGatewaySnapshotRequest,
  ): Promise<BrowserGatewayResult<(BrowserSnapshot & { text: string }) | null>> {
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return this.applySnapshotExtraction(
        await this.existingTabOperations.snapshot(request, existingTab),
        request.extractionHint,
      );
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
      return this.applySnapshotExtraction(
        this.result({
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
            text: boundBrowserText(snapshot.text),
          },
        }),
        request.extractionHint,
      );
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

  /**
   * WS11.2: with `browserAuxExtractionEnabled` ON and an extractionHint on the
   * request, replace the (already redacted + spillover-bounded) snapshot text
   * with an aux-model extract, preserving the spillover reference so the raw
   * capture stays reachable. Best-effort — any failure keeps the raw text.
   */
  private async applySnapshotExtraction(
    result: BrowserGatewayResult<(BrowserSnapshot & { text: string }) | null>,
    extractionHint: string | undefined,
  ): Promise<BrowserGatewayResult<(BrowserSnapshot & { text: string }) | null>> {
    const rawText = result.data?.text;
    if (!rawText || !extractionHint?.trim()) return result;
    const extracted = await maybeExtractPageText(rawText, extractionHint);
    if (extracted === null) return result;
    // Preserve the spillover reference truncateToolOutput embedded, if any.
    const spillNote = /\n\n\[Output truncated\.[^\]]*\]$/.exec(rawText)?.[0] ?? '';
    return {
      ...result,
      data: { ...result.data!, text: `${extracted}${spillNote}` },
    };
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
    // Target-resolution parity with snapshot/click: an extension-driven (shared
    // Chrome) tab is resolved through the extension tab store, NOT the
    // managed-profile store — otherwise every read here fell through to
    // profile_target_or_url_not_found (console-read prompt, req #1).
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return readExistingTabConsoleMessages(this.existingTabCaptureDeps(), request, existingTab);
    }
    return this.readTargetData(
      request,
      'console_messages',
      'browser.console_messages',
      'console messages',
      (profileId, targetId) => this.driver.consoleMessages(profileId, targetId),
    );
  }

  /**
   * Collaborators for the extension-driven capture read: the shared result
   * builder and the existing-tab command bridge (public `sendCommand`).
   */
  private existingTabCaptureDeps() {
    return {
      result: <T>(input: BrowserGatewayResultInput<T>) => this.result(input),
      sendCommand: (
        attachment: BrowserExistingTabAttachment,
        command: BrowserExtensionCommandName,
        payload: Record<string, unknown> | undefined,
        timeoutMs: number,
      ) => this.existingTabOperations.sendCommand(attachment, command, payload, timeoutMs),
    };
  }

  async networkRequests(
    request: BrowserGatewayTargetRequest,
  ): Promise<BrowserGatewayResult<unknown[] | null>> {
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      return readExistingTabNetworkRequests(this.existingTabCaptureDeps(), request, existingTab);
    }
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
          }, HEAVY_DOM_COMMAND_TIMEOUT_MS),
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

  async assertPersisted(
    request: BrowserGatewayContext & BrowserAssertPersistedRequest,
  ): Promise<BrowserGatewayResult<BrowserAssertPersistedData | null>> {
    return assertPersistedOperation(this.reliabilityOperationDeps(), request);
  }

  async writeJournalList(
    request: BrowserGatewayContext & BrowserWriteJournalRequest,
  ): Promise<BrowserGatewayResult<BrowserWriteJournalEntry[] | null>> {
    return writeJournalListOperation(this.reliabilityOperationDeps(), request);
  }

  private reliabilityOperationDeps(): BrowserReliabilityOperationDeps {
    return {
      result: <T>(params: BrowserGatewayResultInput<T>) => this.result(params),
      getTab: (profileId, targetId) => this.extensionTabStore.getTab(profileId, targetId),
      persistenceSentinel: this.persistenceSentinel,
      writeJournal: this.writeJournal,
      sendExtensionCommand: (request) => this.extensionCommandStore.sendCommand(request),
      readControlForTarget: (profileId, targetId, selector) =>
        this.readControlForTarget(profileId, targetId, selector),
    };
  }

  async accessibilitySnapshot(
    request: BrowserGatewayContext & BrowserAccessibilitySnapshotRequest,
  ): Promise<BrowserGatewayResult<BrowserAccessibilityNode[] | null>> {
    const interestingOnly = request.interestingOnly !== false;
    const limit = request.limit ?? 2000;
    const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
    if (existingTab) {
      const originDecision = isOriginAllowed(existingTab.url, existingTab.allowedOrigins);
      if (!originDecision.allowed) {
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'accessibility_snapshot',
          toolName: 'browser.accessibility_snapshot',
          actionClass: 'read',
          decision: 'denied',
          outcome: 'not_run',
          reason: originDecision.reason,
          summary: `Existing-tab accessibility snapshot denied by Browser Gateway origin policy: ${originDecision.reason}`,
          url: existingTab.url,
          data: null,
        });
      }
      try {
        const data = normalizeAccessibilityNodes(
          await this.existingTabOperations.sendCommand(existingTab, 'accessibility_snapshot', {
            interestingOnly,
            limit,
          }, HEAVY_DOM_COMMAND_TIMEOUT_MS),
          limit,
        );
        return this.result({
          context: request,
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          action: 'accessibility_snapshot',
          toolName: 'browser.accessibility_snapshot',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'succeeded',
          summary: `Read ${data.length} accessibility nodes from selected existing Chrome tab`,
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
          action: 'accessibility_snapshot',
          toolName: 'browser.accessibility_snapshot',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'failed',
          reason: message,
          summary: `Existing-tab accessibility snapshot failed: ${message}`,
          origin: originDecision.origin,
          url: existingTab.url,
          data: null,
        });
      }
    }

    return this.readTargetData(
      request,
      'accessibility_snapshot',
      'browser.accessibility_snapshot',
      'accessibility tree',
      async (profileId, targetId) =>
        normalizeAccessibilityNodes(
          await this.driver.accessibilitySnapshot(profileId, targetId, { interestingOnly, limit }),
          limit,
        ),
    );
  }

  async evaluate(
    request: BrowserGatewayContext & BrowserEvaluateRequest,
  ): Promise<BrowserGatewayResult<BrowserEvaluateResult | null>> {
    // Arbitrary JS execution is the most powerful browser capability, so it is
    // always gated behind an explicit grant (hardStop). YOLO/autonomous
    // auto-approve predicates may still satisfy the gate, consistent with the
    // rest of the mutating-action model. The expression is surfaced via the
    // action hint so the approving user sees exactly what JS they are approving,
    // and a benign ':root' selector lets the managed-profile gate inspect a real
    // element (avoiding a misleading element_context_unavailable approval).
    const expressionPreview = request.expression.slice(0, 400);
    const evaluateHint = request.actionHint
      ? `${request.actionHint}: ${expressionPreview}`
      : `evaluate: ${expressionPreview}`;
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'evaluate',
      'browser.evaluate',
      ':root',
      evaluateHint,
      {
        actionClass: 'unknown',
        hardStop: true,
        reason: 'browser_evaluate_requires_user',
      },
    );
    if (prepared.result) {
      return prepared.result as BrowserGatewayResult<BrowserEvaluateResult | null>;
    }
    const recheck = this.actionGuard.recheckPreparedGrant(request, 'evaluate', 'browser.evaluate', prepared);
    if (recheck) {
      return recheck as BrowserGatewayResult<BrowserEvaluateResult | null>;
    }
    try {
      const existingTab = this.extensionTabStore.getTab(request.profileId, request.targetId);
      const raw = existingTab
        ? await this.existingTabOperations.sendCommand(existingTab, 'evaluate', {
          expression: request.expression,
          awaitPromise: request.awaitPromise !== false,
        }, HEAVY_DOM_COMMAND_TIMEOUT_MS)
        : await this.driver.evaluate(
          request.profileId,
          request.targetId,
          request.expression,
          request.awaitPromise !== false,
        );
      const data = normalizeEvaluateResult(raw);
      return this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'evaluate',
        toolName: 'browser.evaluate',
        actionClass: prepared.actionClass,
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'browser.evaluate executed under approved grant',
        origin: prepared.origin,
        url: prepared.url,
        grantId: prepared.grant.id,
        autonomous: prepared.grant.autonomous,
        data,
      });
    } catch (error) {
      return this.actionGuard.mutationFailed(
        request,
        'evaluate',
        'browser.evaluate',
        prepared,
        error,
      ) as BrowserGatewayResult<BrowserEvaluateResult | null>;
    }
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
    return this.manualHandoffOperations.createManualHandoffApproval({
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
    return this.manualHandoffOperations.createManualHandoffApproval({
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
    const uidGuard = this.guardUidTargeting(request, 'click', 'browser.click');
    if (uidGuard) {
      return uidGuard;
    }
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'click',
      'browser.click',
      browserActionTargetLabel(request),
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
          ...browserActionTargetPayload(request), ...(request.verify ? { verify: request.verify } : {}),
        });
      } else {
        await this.driver.click(request.profileId, request.targetId, request.selector!);
      }
      await this.verifyMutationReadback(request, request.verify, request.selector, existingTab ?? undefined);
      return this.actionGuard.mutationSucceeded(request, 'click', 'browser.click', prepared);
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
    const uidGuard = this.guardUidTargeting(request, 'type', 'browser.type');
    if (uidGuard) {
      return uidGuard;
    }
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'type',
      'browser.type',
      browserActionTargetLabel(request),
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
          ...browserActionTargetPayload(request), value: request.value, ...(request.verify ? { verify: request.verify } : {}),
        });
      } else {
        await this.driver.type(request.profileId, request.targetId, request.selector!, request.value);
      }
      await this.verifyMutationReadback(request, request.verify, request.selector, existingTab ?? undefined);
      return this.actionGuard.mutationSucceeded(request, 'type', 'browser.type', prepared);
    } catch (error) {
      return this.actionGuard.mutationFailed(request, 'type', 'browser.type', prepared, error);
    }
  }

  async select(
    request: BrowserGatewayContext & BrowserSelectRequest,
  ): Promise<BrowserGatewayResult<null>> {
    const uidGuard = this.guardUidTargeting(request, 'select', 'browser.select');
    if (uidGuard) {
      return uidGuard;
    }
    const prepared = await this.actionGuard.prepareMutatingAction(
      request,
      'select',
      'browser.select',
      browserActionTargetLabel(request),
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
          ...browserActionTargetPayload(request), value: request.value, ...(request.verify ? { verify: request.verify } : {}),
        });
      } else {
        await this.driver.select(request.profileId, request.targetId, request.selector!, request.value);
      }
      await this.verifyMutationReadback(request, request.verify, request.selector, existingTab ?? undefined);
      return this.actionGuard.mutationSucceeded(request, 'select', 'browser.select', prepared);
    } catch (error) {
      return this.actionGuard.mutationFailed(request, 'select', 'browser.select', prepared, error);
    }
  }

  /**
   * Execute a structured fill plan with read-back verification of every step.
   * Each mutating step is routed through the already-guarded per-action methods
   * (type/select/click) so grants, classification (a `section_save` hits the
   * submit class) and audit apply per step; the plan stops and fails loudly on
   * the first step whose read-back does not match. Managed-profile only for now:
   * verification uses the puppeteer page bridge, which shared existing tabs do
   * not expose.
   */
  async executeFillPlan(
    request: BrowserGatewayExecuteFillPlanRequest,
  ): Promise<BrowserGatewayResult<FillPlanResult | null>> {
    return executeFillPlanOperation(this.fillOperationDeps(), request);
  }

  /** Shared deps facade for the extracted fill operations (see browser-form-fill-operations). */
  private fillOperationDeps(): FillOperationDeps {
    return {
      result: (input) => this.result(input),
      hasExistingTab: (profileId, targetId) => Boolean(this.extensionTabStore.getTab(profileId, targetId)),
      // Key the opt-in by the same stable node scope the authorization uses (not
      // the ephemeral existing-tab profileId), so a future per-node allowlist
      // reader resolves correctly. The global-flag reader ignores the argument.
      sharedTabCredentialFillAllowed: (profileId) =>
        this.allowSharedTabCredentialFill(credentialAuthorizationProfileScope(profileId)),
      resolveCredentialProfileScope: (profileId) => credentialAuthorizationProfileScope(profileId),
      type: (req) => this.type(req as BrowserGatewayContext & BrowserTypeRequest),
      select: (req) => this.select(req as BrowserGatewayContext & BrowserSelectRequest),
      click: (req) => this.click(req as BrowserGatewayContext & BrowserClickRequest),
      // Shared existing tabs have no puppeteer page — read-back + typing route
      // through the extension command channel instead (same channel browser.type
      // uses); the driver path stays for managed profiles.
      readControl: (profileId, targetId, selector) => this.readControlForTarget(profileId, targetId, selector),
      driverType: (profileId, targetId, selector, value) =>
        this.driverTypeForTarget(profileId, targetId, selector, value),
      refreshTargetOrigin: (profileId, targetId) => this.refreshTargetOrigin(profileId, targetId),
      ...(this.credentialVault ? { credentialVault: this.credentialVault } : {}),
      ...(this.credentialAuthorizations ? { credentialAuthorizations: this.credentialAuthorizations } : {}),
      ...(this.emailCodeReader ? { emailCodeReader: this.emailCodeReader } : {}),
      recordNewAccount: (request) => getBrowserCampaignRuntime()?.recordNewAccount(request),
    };
  }

  /** Read a control value, via the extension for shared tabs or the driver otherwise. */
  private async readControlForTarget(
    profileId: string,
    targetId: string,
    selector: string,
  ): Promise<FillControlReadback> {
    const existingTab = this.extensionTabStore.getTab(profileId, targetId);
    if (existingTab) {
      return normalizeExistingTabControlReadback(
        await this.existingTabOperations.sendCommand(
          existingTab,
          'read_control',
          { selector },
          HEAVY_DOM_COMMAND_TIMEOUT_MS,
        ),
      );
    }
    return this.driver.readControl(profileId, targetId, selector);
  }

  /**
   * Type a value into a field. For shared existing tabs the secret is handed to
   * the extension `type` command (the only way to reach a tab with no puppeteer
   * page); it is never logged or returned. Managed profiles keep the driver path.
   */
  private async driverTypeForTarget(
    profileId: string,
    targetId: string,
    selector: string,
    value: string,
  ): Promise<void> {
    const existingTab = this.extensionTabStore.getTab(profileId, targetId);
    if (existingTab) {
      await this.existingTabOperations.sendCommand(existingTab, 'type', { selector, value });
      return;
    }
    await this.driver.type(profileId, targetId, selector, value);
  }

  /**
   * Resolve the LIVE page origin of a fill target. For a shared existing tab a
   * fresh snapshot is taken so a credential fill can never authorize against a
   * stale origin the tab has since navigated away from (fail-closed on any
   * error). Managed profiles use the puppeteer target refresh.
   */
  private async refreshTargetOrigin(profileId: string, targetId: string): Promise<string> {
    const existingTab = this.extensionTabStore.getTab(profileId, targetId);
    if (existingTab) {
      const raw = await this.existingTabOperations.sendCommand(
        existingTab,
        'snapshot',
        undefined,
        HEAVY_DOM_COMMAND_TIMEOUT_MS,
      );
      const url = tryParseWebUrl(extractTabPayload(raw).url);
      return url ? url.origin : '';
    }
    const target = await this.driver.refreshTarget(profileId, targetId);
    return target.origin ?? '';
  }

  /**
   * Fill credential fields from the agent credential vault WITHOUT the secret
   * ever entering model context: the request carries only a vault item
   * reference; the secret is resolved in-process (folder- + origin-jailed) and
   * typed straight into the page. Gated by a standing James-granted credential
   * authorization for (profile scope, live origin, purpose) — this is the
   * sanctioned bypass of the credential hard-stop. Runs on agent-owned managed
   * profiles, and additionally on the user's shared existing tabs when the
   * operator has set `browserAllowSharedTabCredentialFill` (authorized by the
   * tab's node scope). The typed secret never appears in the tool result or audit.
   */
  async fillCredential(
    request: BrowserGatewayFillCredentialRequest,
  ): Promise<BrowserGatewayResult<{ filled: number } | null>> {
    return fillCredentialOperation(this.fillOperationDeps(), request);
  }

  /**
   * Fill GENERIC secret fields (bank account/sort code/IBAN/BIC/tax id/policy
   * number/named field) from the vault via the secret broker WITHOUT the value
   * ever entering model context, a tool result, a log, or the audit trail. The
   * request carries only opaque references; the secret is resolved in-process
   * (folder + origin jailed), typed straight into the page, and verified in the
   * worker by non-reversible digest. Gated by a standing `secret_fill`
   * authorization bound to (profile scope, live origin, semantic secret type).
   */
  async fillSecret(
    request: BrowserGatewayFillSecretRequest,
  ): Promise<BrowserGatewayResult<{ filled: number; verified: number } | null>> {
    return fillSecretOperation(this.fillOperationDeps(), request);
  }

  async createAgentCredential(
    request: BrowserGatewayCreateAgentCredentialRequest,
  ): Promise<BrowserGatewayResult<{ vaultItemRef: string; username: string } | null>> {
    return createAgentCredentialOperation(this.fillOperationDeps(), request);
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
        userDataPath: placeholderExistingTabProfileRoot(request.filePath),
        profileRoot: placeholderExistingTabProfileRoot(request.filePath),
        autonomous: prepared.grant.autonomous,
      });
      if (!uploadDecision.allowed) {
        const approvalOutcome = this.resolveUploadApproval(request, prepared, uploadDecision);
        if (approvalOutcome.result) {
          return approvalOutcome.result;
        }
        prepared = {
          grant: approvalOutcome.autoGrant,
          actionClass: 'file-upload',
          origin: prepared.origin,
          url: prepared.url,
        };
      }
      try {
        let uploadFilePath = uploadDecision.resolvedPath ?? request.filePath;
        const uploadStat = await fs.stat(uploadFilePath);
        if (existingTab.nodeId) {
          // The tab lives in Chrome on a remote worker node, but the file (and
          // the validation above) is coordinator-local. Ship the bytes to the
          // node first and hand the extension a path that exists THERE —
          // otherwise DOM.setFileInputFiles backs the input with a nonexistent
          // path and the site receives an empty/unreadable file.
          const staging = await this.stageUploadFileOnNode(existingTab.nodeId, uploadFilePath);
          uploadFilePath = staging.remotePath;
        }
        const uploadResult = await this.existingTabOperations.sendCommand(existingTab, 'upload_file', {
          selector: request.selector,
          filePath: uploadFilePath,
        });
        verifyUploadedFileSelection(uploadResult, {
          fileName: basenameForUploadPath(uploadFilePath),
          size: uploadStat.size,
        });
        return this.actionGuard.mutationSucceeded(request, 'upload_file', 'browser.upload_file', prepared);
      } catch (error) {
        return this.actionGuard.mutationFailed(
          request,
          'upload_file',
          'browser.upload_file',
          prepared,
          appendBrowserUploadRecoveryHint(error, {
            url: prepared.url,
            actionHint: request.actionHint,
          }),
        );
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
      const approvalOutcome = this.resolveUploadApproval(request, prepared, uploadDecision);
      if (approvalOutcome.result) {
        return approvalOutcome.result;
      }
      prepared = {
        grant: approvalOutcome.autoGrant,
        actionClass: 'file-upload',
        origin: prepared.origin,
        url: prepared.url,
      };
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

  /**
   * Record a stored approval request for a denied upload, then try
   * auto-approval. Every upload path (managed profile AND shared existing
   * tab) must come through here: returning `requires_user` without a stored
   * request leaves the user nothing to approve anywhere in the UI, so the
   * agent waits on a decision that can never be made.
   */
  private resolveUploadApproval(
    request: BrowserGatewayContext & BrowserUploadFileRequest,
    prepared: BrowserGatewayPreparedMutation,
    uploadDecision: BrowserUploadPolicyResult,
  ):
    | { autoGrant: BrowserPermissionGrant; result?: undefined }
    | { autoGrant?: undefined; result: BrowserGatewayResult<null> } {
    if (uploadDecision.reason === 'file_not_found') {
      // No approval could make a nonexistent file uploadable, so a stored
      // request would only mislead the user. The common cause is an agent
      // passing a worker-node path after pre-copying the file there.
      return {
        result: this.result({
          context: request,
          profileId: request.profileId,
          targetId: request.targetId,
          action: 'upload_file',
          toolName: 'browser.upload_file',
          actionClass: 'file-upload',
          decision: 'denied',
          outcome: 'not_run',
          // `reason` is the only field the calling agent sees — summary goes
          // to the audit log. Keep the machine-readable code as the prefix.
          reason:
            'file_not_found: filePath must be readable on the coordinator (the machine '
            + 'running AI Orchestrator). Pass a coordinator-local path even for tabs on a '
            + 'remote worker node — Browser Gateway stages the file onto the node '
            + 'automatically. Do not pre-copy the file to the node and pass a node-local path.',
          summary: 'browser.upload_file denied: filePath not readable on the coordinator',
          origin: prepared.origin,
          url: prepared.url,
          data: null,
        }),
      };
    }
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
        uploadRoots: proposedUploadRoots(prepared.grant.uploadRoots, uploadDecision.resolvedPath),
        autonomous: false,
      },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    const autoGrant = this.autoApproveApproval(approval);
    if (autoGrant) {
      return { autoGrant };
    }
    return {
      result: this.result({
        context: request,
        profileId: request.profileId,
        targetId: request.targetId,
        action: 'upload_file',
        toolName: 'browser.upload_file',
        actionClass: 'file-upload',
        decision: 'requires_user',
        outcome: 'not_run',
        requestId: approval.requestId,
        // `reason` is the only field the calling agent sees — summary goes to
        // the audit log. Keep the machine-readable code as the prefix.
        reason:
          `${uploadDecision.reason}: a pending approval request was recorded. `
          + 'Ask the user to approve it on this instance\'s approvals card (below '
          + 'the chat) or on the Browser Gateway page (/browser), then retry the '
          + 'upload. There is no popup dialog.',
        summary: `browser.upload_file requires user approval: ${uploadDecision.reason}`,
        origin: prepared.origin,
        url: prepared.url,
        data: null,
      }),
    };
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

      this.actionGuard.recordMutationSucceeded(prepared);
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
        browserFillFieldTargetLabel(firstField),
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
        await this.verifyFillFormReadback(request, request.fields, existingTab);
        return this.actionGuard.mutationSucceeded(request, 'fill_form', 'browser.fill_form', prepared);
      } catch (error) {
        return this.actionGuard.mutationFailed(request, 'fill_form', 'browser.fill_form', prepared, error);
      }
    }

    if (request.fields.some((field) => Boolean(field.uid))) {
      return this.denyUidRequiresExistingTab(request, 'fill_form', 'browser.fill_form');
    }

    const gate = await this.actionGuard.prepareMutatingAction(
      request,
      'fill_form',
      'browser.fill_form',
      browserFillFieldTargetLabel(firstField),
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
          selector: field.selector!,
          actionHint: field.actionHint,
          elementContext: redactElementContext(
            await this.driver.inspectElement(
              request.profileId,
              request.targetId,
              field.selector!,
            ),
          ),
        });
      } catch {
        const prepared = await this.actionGuard.prepareMutatingAction(
          request,
          'fill_form',
          'browser.fill_form',
          field.selector!,
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
        browserFillFieldTargetLabel(firstField),
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
      browserFillFieldTargetLabel(request.fields[0]!),
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
        selector: field.selector!,
        value: field.value,
      })));
      await this.verifyFillFormReadback(request, request.fields);
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

  private async readTargetData<T>(
    request: BrowserGatewayTargetRequest,
    action: string,
    toolName: string,
    label: string,
    read: (profileId: string, targetId: string) => Promise<T>,
  ): Promise<BrowserGatewayResult<T | null>> {
    return readBrowserTargetData({
      request,
      action,
      toolName,
      label,
      profileStore: this.profileStore,
      getLiveTarget: (profileId, targetId) => this.getLiveTarget(profileId, targetId),
      result: <R>(input: BrowserGatewayResultInput<R>) => this.result(input),
      read,
    });
  }

  private async verifyFillFormReadback(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    fields: BrowserFillFormRequest['fields'],
    existingTab?: BrowserExistingTabAttachment,
  ): Promise<void> {
    await verifyGatewayFillFormReadback(this.mutationReadbackDeps(), request, fields, existingTab);
  }

  private async verifyMutationReadback(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    expected: BrowserControlVerifyExpectation | undefined,
    fallbackSelector: string | undefined,
    existingTab?: BrowserExistingTabAttachment,
  ): Promise<void> {
    await verifyGatewayMutationReadback(this.mutationReadbackDeps(), request, expected, fallbackSelector, existingTab);
  }

  private mutationReadbackDeps(): BrowserGatewayMutationReadbackDeps {
    return {
      existingTabOperations: this.existingTabOperations,
      driver: this.driver,
    };
  }

  // uid (CDP backendNodeId) targeting is resolved by the Chrome extension via
  // the DevTools protocol, which only exists for shared existing tabs. Managed
  // Puppeteer profiles still use selector-based acting, so a uid-only request
  // against a managed profile is rejected rather than silently mis-targeted.
  private guardUidTargeting(
    request: BrowserGatewayContext & { profileId: string; targetId: string; uid?: string },
    action: string,
    toolName: string,
  ): BrowserGatewayResult<null> | null {
    if (!request.uid) {
      return null;
    }
    if (this.extensionTabStore.getTab(request.profileId, request.targetId)) {
      return null;
    }
    return this.denyUidRequiresExistingTab(request, action, toolName);
  }

  private denyUidRequiresExistingTab(
    request: BrowserGatewayContext & { profileId: string; targetId: string },
    action: string,
    toolName: string,
  ): BrowserGatewayResult<null> {
    return this.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'unknown',
      decision: 'denied',
      outcome: 'not_run',
      reason: 'uid_targeting_requires_existing_tab',
      summary: `${toolName} uid targeting is only supported on shared existing Chrome tabs; use a CSS selector for managed profiles`,
      data: null,
    });
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

}

/**
 * Profile key a credential authorization is checked against for a given live
 * target. Managed profiles authorize by their own id; a shared existing tab
 * authorizes by its stable node scope (nodeId, or 'local') — its own profileId
 * is per-tab/ephemeral, so authorizing by it could never be "standing". Mirrors
 * how shared-tab grants are scoped (browser-grant-scope.ts).
 */
function credentialAuthorizationProfileScope(profileId: string): string {
  return existingTabGrantNodeId(profileId) ?? profileId;
}

export function getBrowserGatewayService(): BrowserGatewayService {
  return BrowserGatewayService.getInstance();
}

export function initializeBrowserGatewayService(
  options: BrowserGatewayServiceOptions = {},
): BrowserGatewayService {
  return BrowserGatewayService.initialize(options);
}
