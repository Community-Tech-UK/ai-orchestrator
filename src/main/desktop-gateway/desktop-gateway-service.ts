import { app } from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  DesktopAccessibilitySnapshotRequest,
  DesktopAccessibilitySnapshotResult,
  DesktopActionResult,
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopGatewayContext,
  DesktopGatewayResult,
  DesktopGrantResolutionRequest,
  DesktopGrantRequest,
  DesktopGrantRequestStatus,
  DesktopHealthData,
  DesktopHotkeyRequest,
  DesktopScrollRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopTypeTextRequest,
  DesktopWaitForRequest,
  DesktopWaitForResult,
} from '../../shared/types/desktop-gateway.types';
import type { AppSettings } from '../../shared/types/settings.types';
import type {
  PermissionDecision,
  PermissionRequest,
} from '../../shared/types/permission-registry.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { decideDesktopAppPolicy } from './desktop-app-policy';
import {
  FileDesktopGatewayAuditStore,
  type DesktopGatewayAuditStore,
} from './desktop-gateway-audit-store';
import {
  grantAllowsObservation,
  InMemoryDesktopGrantStore,
  type DesktopGrantStore,
  type DesktopPermissionGrant,
} from './desktop-grant-store';
import { DesktopInputController } from './desktop-input-controller';
import { redactDesktopMetadata } from './desktop-redaction';
import {
  FileDesktopSessionLock,
  type DesktopSessionLock,
} from './desktop-session-lock';
import {
  createDefaultDesktopDriver,
  type DesktopDriver,
} from './platform/desktop-driver';

interface DesktopGatewaySettingsReader {
  get<K extends keyof Pick<
    AppSettings,
    | 'computerUseEnabled'
    | 'computerUseAllowedAppsJson'
    | 'computerUseDeniedAppsJson'
    | 'computerUseRequireApprovalForInput'
    | 'computerUseStoreScreenshotsForEscalations'
  >>(key: K): AppSettings[K];
}

export interface DesktopGatewayServiceOptions {
  driver?: DesktopDriver;
  settings?: DesktopGatewaySettingsReader;
  auditStore?: DesktopGatewayAuditStore;
  grantStore?: DesktopGrantStore;
  sessionLock?: DesktopSessionLock;
  permissionRegistry?: DesktopPermissionRegistry | null;
  now?: () => number;
  tokenBytes?: () => string;
  userDataPath?: string;
  lockPath?: string;
}

const OBSERVATION_TOKEN_TTL_MS = 15_000;
const DEFAULT_GRANT_TTL_MS = 60 * 60 * 1000;

interface PendingGrantRequest {
  context: DesktopGatewayContext;
  request: DesktopGrantRequest;
  status: DesktopGrantRequestStatus;
  expiresAt: number;
}

interface DesktopPermissionRegistry {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
}

export class DesktopGatewayService {
  private readonly driver: DesktopDriver;
  private readonly settings: DesktopGatewaySettingsReader;
  private readonly auditStore: DesktopGatewayAuditStore;
  private readonly grantStore: DesktopGrantStore;
  private readonly sessionLock: DesktopSessionLock;
  private readonly permissionRegistry: DesktopPermissionRegistry | null;
  private readonly inputController: DesktopInputController;
  private readonly now: () => number;
  private readonly tokenBytes: () => string;
  private readonly grantRequests = new Map<string, PendingGrantRequest>();
  private readonly observationTokens = new Map<string, { appId: string; expiresAt: number }>();

  constructor(options: DesktopGatewayServiceOptions = {}) {
    const userDataPath = options.userDataPath ?? app?.getPath?.('userData') ?? os.tmpdir();
    this.driver = options.driver ?? createDefaultDesktopDriver();
    this.settings = options.settings ?? getSettingsManager();
    this.auditStore = options.auditStore
      ?? new FileDesktopGatewayAuditStore(userDataPath);
    this.grantStore = options.grantStore ?? new InMemoryDesktopGrantStore();
    this.sessionLock = options.sessionLock
      ?? new FileDesktopSessionLock(options.lockPath ?? path.join(userDataPath, 'computer-use.lock'));
    this.permissionRegistry = options.permissionRegistry ?? null;
    this.now = options.now ?? Date.now;
    this.tokenBytes = options.tokenBytes ?? (() => randomIdPart());
    this.inputController = new DesktopInputController({
      driver: this.driver,
      sessionLock: this.sessionLock,
      requireApprovalForInput: () => this.settings.get('computerUseRequireApprovalForInput') !== false,
      now: this.now,
      requireObservableApp: (context, toolName, appId) =>
        this.requireObservableApp(context, toolName, appId),
      validateObservationToken: (token, appId) =>
        this.validateObservationToken(token, appId),
      createObservationToken: (appId) => this.createObservationToken(appId),
      findActiveGrant: (context, appId, predicate) =>
        this.findActiveGrant(context, appId, predicate),
      audit: (context, toolName, decision, resultCode, reason, metadata, appId, grantId) =>
        this.audit(context, toolName, decision, resultCode, reason, metadata, appId, grantId),
    });
  }

  async health(
    context: DesktopGatewayContext,
  ): Promise<DesktopGatewayResult<DesktopHealthData>> {
    const driverHealth = await this.driver.health();
    const enabled = this.settings.get('computerUseEnabled') === true;
    const data: DesktopHealthData = {
      ...driverHealth,
      enabled,
      lockAvailable: true,
      injectable: enabled && driverHealth.supported,
    };
    await this.audit(context, 'computer.health', 'allowed', 'ok', undefined, {});
    return allowed(data);
  }

  async listApps(
    context: DesktopGatewayContext,
    request: { limit?: number } = {},
  ): Promise<DesktopGatewayResult<{ apps: DesktopAppDescriptor[] }>> {
    if (!this.isEnabled()) {
      await this.audit(context, 'computer.list_apps', 'denied', 'not_run', 'computer_use_disabled');
      return denied('computer_use_disabled');
    }
    const apps = (await this.driver.listApps())
      .slice(0, request.limit ?? 200)
      .map((candidate) => this.annotateApp(candidate));
    await this.audit(context, 'computer.list_apps', 'allowed', 'ok', undefined, { count: apps.length });
    return allowed({ apps });
  }

  async requestAppGrant(
    context: DesktopGatewayContext,
    request: DesktopGrantRequest,
  ): Promise<DesktopGatewayResult<DesktopGrantRequestStatus>> {
    if (!this.isEnabled()) {
      await this.audit(context, 'computer.request_app_grant', 'denied', 'not_run', 'computer_use_disabled');
      return denied('computer_use_disabled');
    }
    const requestedApp = await this.findAnnotatedApp(request.appId)
      ?? this.annotateApp({
        appId: request.appId,
        displayName: request.appId,
        platform: process.platform,
        visibleWindowCount: 0,
      });
    if (requestedApp.policyStatus === 'denied') {
      await this.audit(
        context,
        'computer.request_app_grant',
        'denied',
        'not_run',
        'computer_use_app_denied',
        { appId: request.appId, reason: request.reason },
        requestedApp.appId,
      );
      return denied('computer_use_app_denied');
    }
    const grantRequest = { ...request, appId: requestedApp.appId };
    const expiresAt = this.computeGrantExpiresAt(grantRequest);
    const status: DesktopGrantRequestStatus = {
      requestId: `grant_${this.tokenBytes()}`,
      status: 'pending',
      appId: grantRequest.appId,
      capability: grantRequest.capability,
      requestedAt: this.now(),
      expiresAt,
    };
    this.grantRequests.set(status.requestId, {
      context,
      request: grantRequest,
      status,
      expiresAt,
    });
    await this.audit(
      context,
      'computer.request_app_grant',
      'allowed',
      'ok',
      undefined,
      { appId: request.appId, capability: request.capability, reason: request.reason },
    );
    this.requestPermissionRegistryApproval(context, requestedApp, grantRequest, status);
    return allowed(status);
  }

  async getApprovalStatus(
    context: DesktopGatewayContext,
    request: { requestId: string },
  ): Promise<DesktopGatewayResult<DesktopGrantRequestStatus>> {
    const pending = this.grantRequests.get(request.requestId);
    const status = pending ? this.currentGrantStatus(pending) : null;
    await this.audit(context, 'computer.get_approval_status', 'allowed', 'ok', undefined, {
      requestId: request.requestId,
    });
    return allowed(status ?? {
      requestId: request.requestId,
      status: 'unknown',
      appId: '',
      capability: 'observe',
      requestedAt: this.now(),
    });
  }

  async resolveAppGrant(
    context: DesktopGatewayContext,
    request: DesktopGrantResolutionRequest,
  ): Promise<DesktopGatewayResult<DesktopGrantRequestStatus>> {
    const pending = this.grantRequests.get(request.requestId);
    if (!pending) {
      return allowed({
        requestId: request.requestId,
        status: 'unknown',
        appId: '',
        capability: 'observe',
        requestedAt: this.now(),
      });
    }
    if (pending.status.status !== 'pending') {
      return allowed(this.currentGrantStatus(pending));
    }
    if (pending.expiresAt <= this.now()) {
      pending.status = { ...pending.status, status: 'expired' };
      await this.audit(context, 'computer.resolve_app_grant', 'denied', 'not_run', 'computer_use_grant_expired', {
        requestId: request.requestId,
      });
      return allowed(pending.status);
    }
    if (!request.approved) {
      pending.status = { ...pending.status, status: 'denied' };
      await this.audit(context, 'computer.resolve_app_grant', 'denied', 'not_run', request.reason, {
        requestId: request.requestId,
        decidedBy: request.decidedBy,
      });
      return allowed(pending.status);
    }
    const grant = await this.grantStore.createGrant({
      id: `desktop_grant_${this.tokenBytes()}_${this.now()}`,
      instanceId: pending.context.instanceId,
      ...(pending.context.provider ? { provider: pending.context.provider } : {}),
      appId: pending.request.appId,
      capability: pending.request.capability,
      createdAt: this.now(),
      expiresAt: pending.expiresAt,
      decidedBy: request.decidedBy,
      ...(request.reason ? { reason: request.reason } : {}),
    });
    pending.status = {
      ...pending.status,
      status: 'approved',
      grantId: grant.id,
      expiresAt: grant.expiresAt,
    };
    await this.audit(context, 'computer.resolve_app_grant', 'allowed', 'ok', undefined, {
      requestId: request.requestId,
      approved: true,
      decidedBy: request.decidedBy,
    }, pending.request.appId, grant.id);
    return allowed(pending.status);
  }

  async screenshot(
    context: DesktopGatewayContext,
    request: DesktopScreenshotRequest,
  ): Promise<DesktopGatewayResult<DesktopScreenshotResult>> {
    const policy = await this.requireObservableApp(context, 'computer.screenshot', request.appId ?? request.windowId);
    if (policy.reason) {
      return denied(policy.reason);
    }
    try {
      const result = await this.driver.screenshot(request);
      if (policy.app && result.appId !== policy.app.appId) {
        await this.audit(context, 'computer.screenshot', 'denied', 'failed', 'computer_use_target_changed', {
          expectedAppId: policy.app.appId,
          actualAppId: result.appId,
        }, policy.app.appId, policy.grantId);
        return denied('computer_use_target_changed', 'failed');
      }
      const data = {
        ...result,
        observationToken: this.createObservationToken(result.appId),
      };
      await this.audit(context, 'computer.screenshot', 'allowed', 'ok', undefined, {
        appId: result.appId,
        ...request.metadata,
      }, result.appId, policy.grantId);
      return allowed(data);
    } catch (error) {
      const reason = errorReason(error, 'computer_use_driver_failed');
      await this.audit(context, 'computer.screenshot', 'denied', 'failed', reason, metadataFromObject(request));
      return denied(reason, 'failed');
    }
  }

  async accessibilitySnapshot(
    context: DesktopGatewayContext,
    request: DesktopAccessibilitySnapshotRequest,
  ): Promise<DesktopGatewayResult<DesktopAccessibilitySnapshotResult>> {
    const policy = await this.requireObservableApp(context, 'computer.accessibility_snapshot', request.appId ?? request.windowId);
    if (policy.reason) {
      return denied(policy.reason);
    }
    try {
      const result = await this.driver.accessibilitySnapshot(request);
      if (policy.app && result.appId !== policy.app.appId) {
        await this.audit(context, 'computer.accessibility_snapshot', 'denied', 'failed', 'computer_use_target_changed', {
          expectedAppId: policy.app.appId,
          actualAppId: result.appId,
        }, policy.app.appId, policy.grantId);
        return denied('computer_use_target_changed', 'failed');
      }
      const data = {
        ...result,
        observationToken: this.createObservationToken(result.appId),
      };
      await this.audit(context, 'computer.accessibility_snapshot', 'allowed', 'ok', undefined, metadataFromObject(request), result.appId, policy.grantId);
      return allowed(data);
    } catch (error) {
      const reason = errorReason(error, 'computer_use_driver_failed');
      await this.audit(context, 'computer.accessibility_snapshot', 'denied', 'failed', reason, metadataFromObject(request));
      return denied(reason, 'failed');
    }
  }

  async getAuditLog(
    context: DesktopGatewayContext,
    request: { appId?: string; limit?: number } = {},
  ): Promise<DesktopGatewayResult<{ entries: DesktopAuditEntry[] }>> {
    const entries = await this.auditStore.list({
      instanceId: context.instanceId,
      ...(request.appId ? { appId: request.appId } : {}),
      limit: request.limit ?? 50,
    });
    return allowed({ entries });
  }

  async raiseEscalation(
    context: DesktopGatewayContext,
    request: { appId?: string; kind: string; reason: string },
  ): Promise<DesktopGatewayResult<{ escalationId: string; status: 'recorded' }>> {
    const escalationId = `esc_${this.tokenBytes()}`;
    await this.audit(
      context,
      'computer.raise_escalation',
      'allowed',
      'ok',
      undefined,
      { escalationId, kind: request.kind, reason: request.reason, appId: request.appId },
      request.appId,
    );
    return allowed({ escalationId, status: 'recorded' });
  }

  async click(
    context: DesktopGatewayContext,
    request: DesktopClickRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.inputController.click(context, request);
  }

  async typeText(
    context: DesktopGatewayContext,
    request: DesktopTypeTextRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.inputController.typeText(context, request);
  }

  async hotkey(
    context: DesktopGatewayContext,
    request: DesktopHotkeyRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.inputController.hotkey(context, request);
  }

  async scroll(
    context: DesktopGatewayContext,
    request: DesktopScrollRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.inputController.scroll(context, request);
  }

  async drag(
    context: DesktopGatewayContext,
    request: DesktopDragRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.inputController.drag(context, request);
  }

  async waitFor(
    context: DesktopGatewayContext,
    request: DesktopWaitForRequest,
  ): Promise<DesktopGatewayResult<DesktopWaitForResult>> {
    return this.inputController.waitFor(context, request);
  }

  private async requireObservableApp(
    context: DesktopGatewayContext,
    toolName: string,
    appId: string | undefined,
  ): Promise<{ app?: DesktopAppDescriptor; grantId?: string; reason?: string }> {
    if (!this.isEnabled()) {
      await this.audit(context, toolName, 'denied', 'not_run', 'computer_use_disabled');
      return { reason: 'computer_use_disabled' };
    }
    if (!appId) {
      await this.audit(context, toolName, 'denied', 'not_run', 'computer_use_target_not_found');
      return { reason: 'computer_use_target_not_found' };
    }
    const apps = (await this.driver.listApps()).map((candidate) => this.annotateApp(candidate));
    const app = apps.find((candidate) =>
      candidate.appId === appId || candidate.windowId === appId,
    );
    if (!app) {
      await this.audit(context, toolName, 'denied', 'not_run', 'computer_use_target_not_found', { appId });
      return { reason: 'computer_use_target_not_found' };
    }
    if (app.policyStatus === 'denied') {
      await this.audit(context, toolName, 'denied', 'not_run', 'computer_use_app_denied', { appId }, app.appId);
      return { app, reason: 'computer_use_app_denied' };
    }
    if (app.policyStatus !== 'allowed') {
      const grant = await this.findActiveGrant(context, app.appId, grantAllowsObservation);
      if (grant) {
        return { app, grantId: grant.id };
      }
      await this.audit(context, toolName, 'denied', 'not_run', 'computer_use_grant_required', { appId }, app.appId);
      return { app, reason: 'computer_use_grant_required' };
    }
    return { app };
  }

  private annotateApp(app: DesktopAppDescriptor): DesktopAppDescriptor {
    const decision = decideDesktopAppPolicy(app, this.settings);
    return {
      ...app,
      policyStatus: decision.status,
      ...(decision.reason ? { blockedReason: decision.reason } : {}),
    };
  }

  private async findAnnotatedApp(appId: string): Promise<DesktopAppDescriptor | null> {
    const apps = (await this.driver.listApps()).map((candidate) => this.annotateApp(candidate));
    return apps.find((candidate) =>
      candidate.appId === appId
      || candidate.windowId === appId
      || candidate.bundleId === appId
      || candidate.executablePath === appId
      || candidate.displayName === appId,
    ) ?? null;
  }

  private isEnabled(): boolean {
    return this.settings.get('computerUseEnabled') === true;
  }

  private createObservationToken(appId: string): string {
    const token = `obs_${this.tokenBytes()}`;
    this.observationTokens.set(token, {
      appId,
      expiresAt: this.now() + OBSERVATION_TOKEN_TTL_MS,
    });
    return token;
  }

  private validateObservationToken(token: string, appId: string): string | null {
    const observation = this.observationTokens.get(token);
    if (!observation || observation.expiresAt <= this.now()) {
      this.observationTokens.delete(token);
      return 'computer_use_stale_observation';
    }
    if (observation.appId !== appId) {
      return 'computer_use_stale_observation';
    }
    return null;
  }

  private computeGrantExpiresAt(request: DesktopGrantRequest): number {
    if (request.duration === 'boundedMinutes' && request.minutes) {
      return this.now() + request.minutes * 60_000;
    }
    if (request.duration === 'session') {
      return this.now() + DEFAULT_GRANT_TTL_MS;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private currentGrantStatus(pending: PendingGrantRequest): DesktopGrantRequestStatus {
    if (pending.status.status === 'pending' && pending.expiresAt <= this.now()) {
      pending.status = { ...pending.status, status: 'expired' };
    }
    return pending.status;
  }

  private requestPermissionRegistryApproval(
    context: DesktopGatewayContext,
    app: DesktopAppDescriptor,
    request: DesktopGrantRequest,
    status: DesktopGrantRequestStatus,
  ): void {
    if (!this.permissionRegistry) {
      return;
    }
    const permissionRequest: PermissionRequest = {
      id: status.requestId,
      instanceId: context.instanceId,
      action: 'desktop_computer_use_grant',
      description: `Allow Computer Use ${request.capability} for ${app.displayName}`,
      toolName: 'computer.request_app_grant',
      details: {
        appId: app.appId,
        displayName: app.displayName,
        capability: request.capability,
        duration: request.duration,
        ...(request.minutes ? { minutes: request.minutes } : {}),
      },
      createdAt: this.now(),
      timeoutMs: 60_000,
    };
    void this.permissionRegistry.requestPermission(permissionRequest)
      .then((decision) => this.resolveAppGrant(context, {
        requestId: status.requestId,
        approved: decision.granted,
        decidedBy: decision.decidedBy,
      }))
      .catch((error) => this.audit(
        context,
        'computer.request_app_grant',
        'denied',
        'failed',
        'computer_use_approval_failed',
        { requestId: status.requestId, error: errorReason(error, 'computer_use_approval_failed') },
        app.appId,
      ));
  }

  private async findActiveGrant(
    context: DesktopGatewayContext,
    appId: string,
    predicate: (grant: DesktopPermissionGrant) => boolean,
  ): Promise<DesktopPermissionGrant | null> {
    const grants = await this.grantStore.listActiveGrants({
      context,
      appId,
      now: this.now(),
    });
    return grants.find(predicate) ?? null;
  }

  private async audit(
    context: DesktopGatewayContext,
    toolName: string,
    decision: DesktopAuditEntry['decision'],
    resultCode: DesktopAuditEntry['resultCode'],
    reason?: string,
    metadata: Record<string, unknown> = {},
    appId?: string,
    grantId?: string,
  ): Promise<void> {
    await this.auditStore.append({
      id: `audit_${this.tokenBytes()}_${this.now()}`,
      timestamp: this.now(),
      instanceId: context.instanceId,
      ...(context.provider ? { provider: context.provider } : {}),
      toolName,
      ...(appId ? { appId } : {}),
      ...(grantId ? { grantId } : {}),
      decision,
      resultCode,
      ...(reason ? { reason } : {}),
      redactedMetadata: redactDesktopMetadata(metadata),
    });
  }
}

function allowed<T>(data: T): DesktopGatewayResult<T> {
  return { decision: 'allowed', outcome: 'ok', data };
}

function denied(reason: string, outcome: DesktopGatewayResult['outcome'] = 'not_run'): DesktopGatewayResult<never> {
  return { decision: 'denied', outcome, reason };
}

function errorReason(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallback;
  }
  const [code] = error.message.split(':');
  return code || fallback;
}

function metadataFromObject(value: object): Record<string, unknown> {
  return { ...(value as Record<string, unknown>) };
}

function randomIdPart(): string {
  return Math.random().toString(36).slice(2, 14);
}

let desktopGatewayService: DesktopGatewayService | null = null;

export function getDesktopGatewayService(): DesktopGatewayService {
  if (!desktopGatewayService) {
    desktopGatewayService = new DesktopGatewayService();
  }
  return desktopGatewayService;
}

export function initializeDesktopGatewayService(
  options: DesktopGatewayServiceOptions = {},
): DesktopGatewayService {
  desktopGatewayService = new DesktopGatewayService(options);
  return desktopGatewayService;
}

export function _resetDesktopGatewayServiceForTesting(): void {
  desktopGatewayService = null;
}
