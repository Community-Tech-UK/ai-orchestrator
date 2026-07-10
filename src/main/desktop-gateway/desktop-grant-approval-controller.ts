import type {
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopGatewayContext,
  DesktopGatewayResult,
  DesktopGrantRequest,
  DesktopGrantRequestStatus,
  DesktopGrantResolutionRequest,
} from '../../shared/types/desktop-gateway.types';
import type {
  PermissionDecision,
  PermissionRequest,
} from '../../shared/types/permission-registry.types';
import type {
  DesktopGrantScope,
  DesktopGrantStore,
} from './desktop-grant-store';
import { allowed, denied, errorReason } from './desktop-gateway-service-helpers';

const DEFAULT_GRANT_TTL_MS = 60 * 60 * 1000;
const APPROVAL_REQUEST_TTL_MS = 60_000;

interface PendingGrantRequest {
  context: DesktopGatewayContext;
  request: DesktopGrantRequest;
  status: DesktopGrantRequestStatus;
  expiresAt: number;
}

export interface DesktopPermissionRegistry {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface DesktopGrantApprovalControllerDeps {
  grantStore: Pick<DesktopGrantStore, 'createGrant'>;
  permissionRegistry: DesktopPermissionRegistry | null;
  isEnabled: () => boolean;
  now: () => number;
  tokenBytes: () => string;
  annotateApp: (app: DesktopAppDescriptor) => DesktopAppDescriptor;
  findAnnotatedApp: (appId: string) => Promise<DesktopAppDescriptor | null>;
  audit: (
    context: DesktopGatewayContext,
    toolName: string,
    decision: DesktopAuditEntry['decision'],
    resultCode: DesktopAuditEntry['resultCode'],
    reason?: string,
    metadata?: Record<string, unknown>,
    appId?: string,
    grantId?: string,
  ) => Promise<void>;
}

/**
 * Owns the app-grant request lifecycle: minting pending requests, routing them
 * through the PermissionRegistry approval card, and materializing durable or
 * session grants on approval. Extracted from the gateway service (mirroring
 * {@link DesktopInputController}) so both stay within the size ratchet and the
 * approval flow is independently reasoned about.
 */
export class DesktopGrantApprovalController {
  private readonly grantRequests = new Map<string, PendingGrantRequest>();

  constructor(private readonly deps: DesktopGrantApprovalControllerDeps) {}

  async requestAppGrant(
    context: DesktopGatewayContext,
    request: DesktopGrantRequest,
  ): Promise<DesktopGatewayResult<DesktopGrantRequestStatus>> {
    if (!this.deps.isEnabled()) {
      await this.deps.audit(context, 'computer.request_app_grant', 'denied', 'not_run', 'computer_use_disabled');
      return denied('computer_use_disabled');
    }
    const requestedApp = await this.deps.findAnnotatedApp(request.appId)
      ?? this.deps.annotateApp({
        appId: request.appId,
        displayName: request.appId,
        platform: process.platform,
        visibleWindowCount: 0,
      });
    if (requestedApp.policyStatus === 'denied') {
      await this.deps.audit(
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
    const expiresAt = this.deps.now() + APPROVAL_REQUEST_TTL_MS;
    const status: DesktopGrantRequestStatus = {
      requestId: `grant_${this.deps.tokenBytes()}`,
      status: 'pending',
      appId: grantRequest.appId,
      capability: grantRequest.capability,
      requestedAt: this.deps.now(),
      expiresAt,
    };
    this.grantRequests.set(status.requestId, {
      context,
      request: grantRequest,
      status,
      expiresAt,
    });
    await this.deps.audit(
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
    await this.deps.audit(context, 'computer.get_approval_status', 'allowed', 'ok', undefined, {
      requestId: request.requestId,
    });
    return allowed(status ?? {
      requestId: request.requestId,
      status: 'unknown',
      appId: '',
      capability: 'observe',
      requestedAt: this.deps.now(),
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
        requestedAt: this.deps.now(),
      });
    }
    if (pending.status.status !== 'pending') {
      return allowed(this.currentGrantStatus(pending));
    }
    if (pending.expiresAt <= this.deps.now()) {
      pending.status = { ...pending.status, status: 'expired' };
      await this.deps.audit(context, 'computer.resolve_app_grant', 'denied', 'not_run', 'computer_use_grant_expired', {
        requestId: request.requestId,
      });
      return allowed(pending.status);
    }
    if (!request.approved) {
      pending.status = { ...pending.status, status: 'denied' };
      await this.deps.audit(context, 'computer.resolve_app_grant', 'denied', 'not_run', request.reason, {
        requestId: request.requestId,
        decidedBy: request.decidedBy,
      });
      return allowed(pending.status);
    }
    const scope: DesktopGrantScope = pending.request.duration === 'untilRevoked'
      ? 'durable'
      : 'session';
    const grantExpiresAt = this.computeGrantExpiresAt(pending.request);
    const grant = await this.deps.grantStore.createGrant({
      id: `desktop_grant_${this.deps.tokenBytes()}_${this.deps.now()}`,
      instanceId: pending.context.instanceId,
      ...(pending.context.provider ? { provider: pending.context.provider } : {}),
      appId: pending.request.appId,
      capability: pending.request.capability,
      scope,
      createdAt: this.deps.now(),
      expiresAt: grantExpiresAt,
      decidedBy: request.decidedBy,
      ...(request.reason ? { reason: request.reason } : {}),
    });
    pending.status = {
      ...pending.status,
      status: 'approved',
      grantId: grant.id,
      expiresAt: grantExpiresAt,
    };
    await this.deps.audit(context, 'computer.resolve_app_grant', 'allowed', 'ok', undefined, {
      requestId: request.requestId,
      approved: true,
      decidedBy: request.decidedBy,
    }, pending.request.appId, grant.id);
    return allowed(pending.status);
  }

  private computeGrantExpiresAt(request: DesktopGrantRequest): number {
    if (request.duration === 'boundedMinutes' && request.minutes) {
      return this.deps.now() + request.minutes * 60_000;
    }
    if (request.duration === 'session') {
      return this.deps.now() + DEFAULT_GRANT_TTL_MS;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private currentGrantStatus(pending: PendingGrantRequest): DesktopGrantRequestStatus {
    if (pending.status.status === 'pending' && pending.expiresAt <= this.deps.now()) {
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
    if (!this.deps.permissionRegistry) {
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
      createdAt: this.deps.now(),
      timeoutMs: 60_000,
    };
    void this.deps.permissionRegistry.requestPermission(permissionRequest)
      .then((decision) => this.resolveAppGrant(context, {
        requestId: status.requestId,
        approved: decision.granted,
        decidedBy: decision.decidedBy,
      }))
      .catch((error) => this.deps.audit(
        context,
        'computer.request_app_grant',
        'denied',
        'failed',
        'computer_use_approval_failed',
        { requestId: status.requestId, error: errorReason(error, 'computer_use_approval_failed') },
        app.appId,
      ));
  }
}
