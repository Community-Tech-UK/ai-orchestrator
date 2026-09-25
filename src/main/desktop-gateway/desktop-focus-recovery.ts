import type {
  DesktopActivateWindowRequest,
  DesktopActivateWindowResult,
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopGatewayContext,
  DesktopGatewayResult,
} from '../../shared/types/desktop-gateway.types';
import type { ResolvedComputerUseAutonomy } from '../instance/lifecycle/computer-use-scoping';
import type { DesktopDriver } from './platform/desktop-driver';
import { activateObservedWindow } from './desktop-window-activation';

const ACTIVATION_LEASE_MS = 15_000;

export interface DesktopFocusRecoveryDeps {
  driver: DesktopDriver;
  now: () => number;
  autonomy: (context: DesktopGatewayContext) => ResolvedComputerUseAutonomy;
  requireObservableApp: (
    context: DesktopGatewayContext,
    toolName: string,
    appId: string | undefined,
    autonomy?: ResolvedComputerUseAutonomy,
  ) => Promise<{
    app?: DesktopAppDescriptor;
    grantId?: string;
    reason?: string;
    autonomy: ResolvedComputerUseAutonomy;
  }>;
  validateObservationToken: (
    token: string,
    appId: string,
    currentWindowId?: string,
  ) => string | null;
  getObservationWindowId: (token: string, appId: string) => string | undefined;
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

interface ActivationLease {
  instanceId: string;
  provider?: string;
  appId: string;
  windowId: string;
  expiresAt: number;
}

export class DesktopFocusRecovery {
  private readonly leases = new Map<string, ActivationLease>();

  constructor(private readonly deps: DesktopFocusRecoveryDeps) {}

  async activate(
    context: DesktopGatewayContext,
    request: DesktopActivateWindowRequest,
  ): Promise<DesktopGatewayResult<DesktopActivateWindowResult>> {
    this.clearForContext(context);
    const autonomy = this.deps.autonomy(context);
    const result = await activateObservedWindow(context, request, {
      driver: this.deps.driver,
      requireObservableApp: (targetContext, toolName, appId) =>
        this.deps.requireObservableApp(targetContext, toolName, appId, autonomy),
      validateObservationToken: this.deps.validateObservationToken,
      getObservationWindowId: this.deps.getObservationWindowId,
      audit: this.deps.audit,
    });
    const windowId = result.data?.activeWindow?.windowId
      ?? request.windowId
      ?? this.deps.getObservationWindowId(request.observationToken, request.appId);
    if (result.decision === 'allowed' && result.data?.activated && windowId) {
      this.leases.set(this.key(context, result.data.appId), {
        instanceId: context.instanceId,
        ...(context.provider ? { provider: context.provider } : {}),
        appId: result.data.appId,
        windowId,
        expiresAt: this.deps.now() + ACTIVATION_LEASE_MS,
      });
    }
    return result;
  }

  consume(
    context: DesktopGatewayContext,
    appId: string,
    windowId: string | undefined,
  ): { restoreFromCallerFocus?: true } {
    const key = this.key(context, appId);
    const lease = this.leases.get(key);
    if (!lease || lease.expiresAt <= this.deps.now()) {
      this.leases.delete(key);
      return {};
    }
    const matches = lease.appId === appId && lease.windowId === windowId;
    if (matches) {
      this.leases.delete(key);
      return { restoreFromCallerFocus: true };
    }
    return {};
  }

  private key(context: DesktopGatewayContext, appId: string): string {
    return JSON.stringify([context.instanceId, context.provider ?? null, appId]);
  }

  private clearForContext(context: DesktopGatewayContext): void {
    const now = this.deps.now();
    for (const [key, lease] of this.leases) {
      const sameContext = lease.instanceId === context.instanceId
        && lease.provider === context.provider;
      if (sameContext || lease.expiresAt <= now) {
        this.leases.delete(key);
      }
    }
  }
}
