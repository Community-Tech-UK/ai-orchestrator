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
  DesktopGrantSummary,
  DesktopHealthData,
  DesktopHotkeyRequest,
  DesktopListGrantsRequest,
  DesktopPermissionRequestResult,
  DesktopQueryElementsRequest,
  DesktopQueryElementsResult,
  DesktopRevokeGrantRequest,
  DesktopRevokeGrantResult,
  DesktopScrollRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopSessionLockHolder,
  DesktopSystemPermission,
  DesktopTypeTextRequest,
  DesktopWaitForRequest,
  DesktopWaitForResult,
} from '../../shared/types/desktop-gateway.types';
import type { AppSettings } from '../../shared/types/settings.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { decideDesktopAppPolicy } from './desktop-app-policy';
import {
  FileDesktopGatewayAuditStore,
  type DesktopGatewayAuditStore,
} from './desktop-gateway-audit-store';
import {
  FileDesktopGrantStore,
  grantAllowsObservation,
  type DesktopGrantStore,
  type DesktopPermissionGrant,
} from './desktop-grant-store';
import { DesktopInputController } from './desktop-input-controller';
import {
  DesktopGrantApprovalController,
  type DesktopPermissionRegistry,
} from './desktop-grant-approval-controller';
import { redactDesktopMetadata } from './desktop-redaction';
import {
  describeLockHolder,
  FileDesktopSessionLock,
  type DesktopSessionLock,
} from './desktop-session-lock';
import {
  createDefaultDesktopDriver,
  type DesktopDriver,
} from './platform/desktop-driver';
import {
  allowed,
  denied,
  errorReason,
  metadataFromObject,
  randomIdPart,
  toGrantSummary,
} from './desktop-gateway-service-helpers';
import { DesktopObservationStore } from './desktop-observation-store';

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

/**
 * Context used for renderer/operator-initiated calls (Settings tab). It is not
 * a real agent instance, so it audits under a stable synthetic id and, combined
 * with `allInstances`, lets the operator view and manage every grant.
 */
const OPERATOR_CONTEXT: DesktopGatewayContext = { instanceId: 'operator' };

export class DesktopGatewayService {
  private readonly driver: DesktopDriver;
  private readonly settings: DesktopGatewaySettingsReader;
  private readonly auditStore: DesktopGatewayAuditStore;
  private readonly grantStore: DesktopGrantStore;
  private readonly sessionLock: DesktopSessionLock;
  private readonly permissionRegistry: DesktopPermissionRegistry | null;
  private readonly inputController: DesktopInputController;
  private readonly grantApproval: DesktopGrantApprovalController;
  private readonly now: () => number;
  private readonly tokenBytes: () => string;
  private readonly observations: DesktopObservationStore;

  constructor(options: DesktopGatewayServiceOptions = {}) {
    const userDataPath = options.userDataPath ?? app?.getPath?.('userData') ?? os.tmpdir();
    this.driver = options.driver ?? createDefaultDesktopDriver();
    this.settings = options.settings ?? getSettingsManager();
    this.auditStore = options.auditStore
      ?? new FileDesktopGatewayAuditStore(userDataPath);
    this.grantStore = options.grantStore ?? new FileDesktopGrantStore(userDataPath);
    this.sessionLock = options.sessionLock
      ?? new FileDesktopSessionLock(options.lockPath ?? path.join(userDataPath, 'computer-use.lock'));
    this.permissionRegistry = options.permissionRegistry ?? null;
    this.now = options.now ?? Date.now;
    this.tokenBytes = options.tokenBytes ?? (() => randomIdPart());
    this.observations = new DesktopObservationStore(this.now, this.tokenBytes);
    this.inputController = new DesktopInputController({
      driver: this.driver,
      sessionLock: this.sessionLock,
      requireApprovalForInput: () => this.settings.get('computerUseRequireApprovalForInput') !== false,
      now: this.now,
      requireObservableApp: (context, toolName, appId) =>
        this.requireObservableApp(context, toolName, appId),
      validateObservationToken: (token, appId, currentWindowId) =>
        this.observations.validate(token, appId, currentWindowId),
      getObservationWindowId: (token, appId) =>
        this.observations.getWindowId(token, appId),
      findObservedElement: (token, appId, uid) =>
        this.observations.findElement(token, appId, uid),
      findFocusedObservedElement: (token, appId) =>
        this.observations.findFocusedElement(token, appId),
      findObservedElementAtPoint: (token, appId, point) =>
        this.observations.findElementAtPoint(token, appId, point),
      createObservationToken: (appId, meta) => this.observations.create(appId, meta),
      findActiveGrant: (context, appId, predicate) =>
        this.findActiveGrant(context, appId, predicate),
      audit: (context, toolName, decision, resultCode, reason, metadata, appId, grantId) =>
        this.audit(context, toolName, decision, resultCode, reason, metadata, appId, grantId),
    });
    this.grantApproval = new DesktopGrantApprovalController({
      grantStore: this.grantStore,
      permissionRegistry: this.permissionRegistry,
      isEnabled: () => this.isEnabled(),
      now: this.now,
      tokenBytes: this.tokenBytes,
      annotateApp: (app) => this.annotateApp(app),
      findAnnotatedApp: (appId) => this.findAnnotatedApp(appId),
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
    return this.grantApproval.requestAppGrant(context, request);
  }

  async getApprovalStatus(
    context: DesktopGatewayContext,
    request: { requestId: string },
  ): Promise<DesktopGatewayResult<DesktopGrantRequestStatus>> {
    return this.grantApproval.getApprovalStatus(context, request);
  }

  async resolveAppGrant(
    context: DesktopGatewayContext,
    request: DesktopGrantResolutionRequest,
  ): Promise<DesktopGatewayResult<DesktopGrantRequestStatus>> {
    return this.grantApproval.resolveAppGrant(context, request);
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
      const targetWindowId = request.windowId ?? policy.app?.windowId;
      const result = await this.driver.screenshot({
        ...request,
        ...(policy.app ? { appId: policy.app.appId } : {}),
        ...(targetWindowId ? { windowId: targetWindowId } : {}),
      });
      if (policy.app && result.appId !== policy.app.appId) {
        await this.audit(context, 'computer.screenshot', 'denied', 'failed', 'computer_use_target_changed', {
          expectedAppId: policy.app.appId,
          actualAppId: result.appId,
        }, policy.app.appId, policy.grantId);
        return denied('computer_use_target_changed', 'failed');
      }
      if (targetWindowId && result.windowId && result.windowId !== targetWindowId) {
        await this.audit(
          context,
          'computer.screenshot',
          'denied',
          'failed',
          'computer_use_target_changed',
          { expectedWindowId: targetWindowId, actualWindowId: result.windowId },
          result.appId,
          policy.grantId,
        );
        return denied('computer_use_target_changed', 'failed');
      }
      const observedWindowId = result.windowId ?? targetWindowId;
      const data = {
        ...result,
        ...(observedWindowId ? { windowId: observedWindowId } : {}),
        observationToken: this.observations.create(result.appId, {
          ...(observedWindowId ? { windowId: observedWindowId } : {}),
          contentHash: DesktopObservationStore.hashContent(result.data),
        }),
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
      const targetWindowId = request.windowId ?? policy.app?.windowId;
      const result = await this.driver.accessibilitySnapshot({
        ...request,
        ...(policy.app ? { appId: policy.app.appId } : {}),
        ...(targetWindowId ? { windowId: targetWindowId } : {}),
      });
      if (policy.app && result.appId !== policy.app.appId) {
        await this.audit(context, 'computer.accessibility_snapshot', 'denied', 'failed', 'computer_use_target_changed', {
          expectedAppId: policy.app.appId,
          actualAppId: result.appId,
        }, policy.app.appId, policy.grantId);
        return denied('computer_use_target_changed', 'failed');
      }
      if (targetWindowId && result.windowId && result.windowId !== targetWindowId) {
        await this.audit(
          context,
          'computer.accessibility_snapshot',
          'denied',
          'failed',
          'computer_use_target_changed',
          { expectedWindowId: targetWindowId, actualWindowId: result.windowId },
          result.appId,
          policy.grantId,
        );
        return denied('computer_use_target_changed', 'failed');
      }
      const observedWindowId = result.windowId ?? targetWindowId;
      const data = {
        ...result,
        ...(observedWindowId ? { windowId: observedWindowId } : {}),
        observationToken: this.observations.create(result.appId, {
          ...(observedWindowId ? { windowId: observedWindowId } : {}),
          snapshot: result.nodes,
        }),
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

  async queryElements(
    context: DesktopGatewayContext,
    request: DesktopQueryElementsRequest,
  ): Promise<DesktopGatewayResult<DesktopQueryElementsResult>> {
    const result = this.observations.query(request);
    if (!result.ok) {
      await this.audit(context, 'computer.query_elements', 'denied', 'not_run', result.reason, metadataFromObject(request), request.appId);
      return denied(result.reason);
    }
    await this.audit(context, 'computer.query_elements', 'allowed', 'ok', undefined, {
      matched: result.candidates.length,
    }, result.appId);
    return allowed({ appId: result.appId, candidates: result.candidates });
  }

  async listGrants(
    context: DesktopGatewayContext,
    request: DesktopListGrantsRequest = {},
  ): Promise<DesktopGatewayResult<{ grants: DesktopGrantSummary[] }>> {
    const grants = await this.grantStore.listGrants({
      context,
      ...(request.appId ? { appId: request.appId } : {}),
      ...(request.includeExpired ? { includeExpired: request.includeExpired } : {}),
      now: this.now(),
      limit: request.limit ?? 100,
    });
    await this.audit(context, 'computer.list_grants', 'allowed', 'ok', undefined, {
      count: grants.length,
    });
    return allowed({ grants: grants.map(toGrantSummary) });
  }

  async revokeGrant(
    context: DesktopGatewayContext,
    request: DesktopRevokeGrantRequest,
  ): Promise<DesktopGatewayResult<DesktopRevokeGrantResult>> {
    const existing = await this.grantStore.listGrants({
      context,
      includeExpired: true,
      now: this.now(),
    });
    const owned = existing.find((grant) => grant.id === request.grantId);
    if (!owned) {
      await this.audit(context, 'computer.revoke_grant', 'denied', 'not_run', 'computer_use_grant_not_found', {
        grantId: request.grantId,
      });
      return denied('computer_use_grant_not_found');
    }
    const revoked = await this.grantStore.revokeGrant(request.grantId, this.now());
    await this.audit(context, 'computer.revoke_grant', 'allowed', 'ok', request.reason, {
      grantId: request.grantId,
    }, owned.appId, request.grantId);
    return allowed({ grantId: request.grantId, revoked: Boolean(revoked) });
  }

  /**
   * Operator-scoped grant listing for the renderer Settings tab: returns grants
   * across every instance rather than a single agent's context.
   */
  async listGrantsForOperator(
    request: DesktopListGrantsRequest = {},
  ): Promise<DesktopGatewayResult<{ grants: DesktopGrantSummary[] }>> {
    const grants = await this.grantStore.listGrants({
      context: OPERATOR_CONTEXT,
      allInstances: true,
      ...(request.appId ? { appId: request.appId } : {}),
      ...(request.includeExpired ? { includeExpired: request.includeExpired } : {}),
      now: this.now(),
      limit: request.limit ?? 100,
    });
    return allowed({ grants: grants.map(toGrantSummary) });
  }

  /**
   * Operator-scoped grant revocation (renderer Settings tab): revoke any grant
   * by id regardless of which instance created it.
   */
  async revokeGrantForOperator(
    request: DesktopRevokeGrantRequest,
  ): Promise<DesktopGatewayResult<DesktopRevokeGrantResult>> {
    const existing = await this.grantStore.listGrants({
      context: OPERATOR_CONTEXT,
      allInstances: true,
      includeExpired: true,
      now: this.now(),
    });
    const owned = existing.find((grant) => grant.id === request.grantId);
    if (!owned) {
      return denied('computer_use_grant_not_found');
    }
    const revoked = await this.grantStore.revokeGrant(request.grantId, this.now());
    await this.audit(OPERATOR_CONTEXT, 'computer.revoke_grant', 'allowed', 'ok', request.reason, {
      grantId: request.grantId,
    }, owned.appId, request.grantId);
    return allowed({ grantId: request.grantId, revoked: Boolean(revoked) });
  }

  /**
   * Operator-only macOS system-permission request (Settings tab, permission
   * banner/chip). Never exposed as an agent MCP tool and never accepts a
   * caller-supplied instance context: it always audits under the stable
   * operator id with safe permission/state metadata only.
   */
  async requestSystemPermissionForOperator(
    permission: DesktopSystemPermission,
  ): Promise<DesktopGatewayResult<DesktopPermissionRequestResult>> {
    if (!this.isEnabled()) {
      await this.audit(
        OPERATOR_CONTEXT,
        'computer.request_permission',
        'denied',
        'not_run',
        'computer_use_disabled',
        { permission },
      );
      return denied('computer_use_disabled');
    }
    try {
      const result = await this.driver.requestSystemPermission(permission);
      await this.audit(OPERATOR_CONTEXT, 'computer.request_permission', 'allowed', 'ok', undefined, {
        permission,
        state: result.state,
        nativeRequestAttempted: result.nativeRequestAttempted,
      });
      return allowed(result);
    } catch (error) {
      const reason = errorReason(error, 'computer_use_driver_failed');
      await this.audit(
        OPERATOR_CONTEXT,
        'computer.request_permission',
        'denied',
        'failed',
        reason,
        { permission },
      );
      return denied(reason, 'failed');
    }
  }

  /**
   * Operator-scoped audit log for the renderer Settings tab: entries across all
   * instances (the audit store treats an undefined instanceId as "all").
   */
  async getAuditLogForOperator(
    request: { appId?: string; limit?: number } = {},
  ): Promise<DesktopGatewayResult<{ entries: DesktopAuditEntry[] }>> {
    const entries = await this.auditStore.list({
      ...(request.appId ? { appId: request.appId } : {}),
      limit: request.limit ?? 100,
    });
    return allowed({ entries });
  }

  /**
   * Recomputes and caches the spawn-injection gate. Called at runtime init and
   * whenever settings change so the (synchronous) spawn-config-builder can
   * decide whether — and with which tool set — to inject the computer-use MCP
   * without doing async driver probes on the spawn hot path.
   */
  async refreshInjectionState(): Promise<DesktopInjectionState> {
    let supported = false;
    let actionToolsHealthy = false;
    try {
      const driverHealth = await this.driver.health();
      supported = driverHealth.supported;
      actionToolsHealthy = driverHealth.screenCapture === 'available'
        || driverHealth.accessibility === 'available';
    } catch {
      supported = false;
      actionToolsHealthy = false;
    }
    cachedInjectionState = {
      supported,
      enabled: this.isEnabled(),
      actionToolsHealthy,
    };
    return cachedInjectionState;
  }

  private async currentLockHolder(): Promise<DesktopSessionLockHolder | undefined> {
    try {
      const holder = await this.sessionLock.inspect();
      return holder ? describeLockHolder(holder) : undefined;
    } catch {
      return undefined;
    }
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

export interface DesktopInjectionState {
  supported: boolean;
  enabled: boolean;
  actionToolsHealthy: boolean;
}

let cachedInjectionState: DesktopInjectionState = {
  supported: process.platform === 'darwin',
  enabled: false,
  actionToolsHealthy: false,
};

/**
 * Last cached spawn-injection gate. Defaults conservatively (assume actions
 * unhealthy) until the runtime probes the driver at startup.
 */
export function getDesktopGatewayInjectionState(): DesktopInjectionState {
  return cachedInjectionState;
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
  cachedInjectionState = {
    supported: process.platform === 'darwin',
    enabled: false,
    actionToolsHealthy: false,
  };
}
