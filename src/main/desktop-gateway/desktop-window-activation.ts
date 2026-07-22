import type {
  DesktopActivateWindowRequest,
  DesktopActivateWindowResult,
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopGatewayContext,
  DesktopGatewayResult,
} from '../../shared/types/desktop-gateway.types';
import type { DesktopDriver } from './platform/desktop-driver';

/**
 * Bring an already-observed window of an already-granted app to the front.
 *
 * Exists because every input action requires its target window to be active,
 * and there was previously no supported way to make a specific observed window
 * active — an agent that could read a background window had to ask the user to
 * foreground it by hand, which is exactly the manual step this removes.
 *
 * Deliberately narrow. It is a navigation prerequisite, NOT permission to
 * mutate: the normal action policy still applies to whatever happens next.
 */

export interface DesktopWindowActivationDeps {
  driver: Pick<DesktopDriver, 'activateWindow'>;
  requireObservableApp: (
    context: DesktopGatewayContext,
    toolName: string,
    appId: string | undefined,
  ) => Promise<{ app?: DesktopAppDescriptor; grantId?: string; reason?: string }>;
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

const TOOL_NAME = 'computer.activate_window';

export async function activateObservedWindow(
  context: DesktopGatewayContext,
  request: DesktopActivateWindowRequest,
  deps: DesktopWindowActivationDeps,
): Promise<DesktopGatewayResult<DesktopActivateWindowResult>> {
  // Same app policy as observation, so denied apps and arbitrary processes are
  // refused rather than raised.
  const policy = await deps.requireObservableApp(context, TOOL_NAME, request.appId);
  if (policy.reason || !policy.app) {
    return denied(policy.reason ?? 'computer_use_target_not_found');
  }
  const app = policy.app;
  const audit = (
    decision: DesktopAuditEntry['decision'],
    resultCode: DesktopAuditEntry['resultCode'],
    reason?: string,
  ): Promise<void> =>
    deps.audit(context, TOOL_NAME, decision, resultCode, reason, { ...request }, app.appId, policy.grantId);

  // Validate against the OBSERVED window, not the app's current front window:
  // requiring the target to already be frontmost is precisely the deadlock this
  // operation removes.
  const observedWindowId = deps.getObservationWindowId(request.observationToken, app.appId);
  const tokenReason = deps.validateObservationToken(
    request.observationToken,
    app.appId,
    observedWindowId,
  );
  if (tokenReason) {
    await audit('denied', 'not_run', tokenReason);
    return denied(tokenReason);
  }

  const targetWindowId = request.windowId ?? observedWindowId;
  if (!targetWindowId) {
    await audit('denied', 'not_run', 'computer_use_target_not_found');
    return denied('computer_use_target_not_found');
  }
  // A caller-supplied window must belong to the granted app, so this can never
  // raise another application's window.
  if (request.windowId && !appOwnsWindow(app, request.windowId)) {
    await audit('denied', 'not_run', 'computer_use_target_not_found');
    return denied('computer_use_target_not_found');
  }

  try {
    const result = await deps.driver.activateWindow({
      appId: app.appId,
      observationToken: request.observationToken,
      windowId: targetWindowId,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    });
    await audit('allowed', 'ok');
    return {
      decision: 'allowed',
      outcome: 'ok',
      data: {
        activated: result.activated,
        appId: app.appId,
        ...(result.activeWindow ? { activeWindow: result.activeWindow } : {}),
        reobserveRequired: true,
      },
    };
  } catch (error) {
    // Audited decision matches the returned decision, as elsewhere in the
    // gateway: a driver refusal is a denial, not an allowed action that failed.
    const reason = errorReason(error);
    await audit('denied', 'failed', reason);
    return { decision: 'denied', outcome: 'failed', reason };
  }
}

/**
 * Whether the descriptor lists this window. Falls back to the app's single
 * reported front window for helper builds that do not enumerate windows.
 */
function appOwnsWindow(app: DesktopAppDescriptor, windowId: string): boolean {
  if (app.windows?.some((window) => window.windowId === windowId)) {
    return true;
  }
  return app.windowId === windowId;
}

function denied(reason: string): DesktopGatewayResult<never> {
  return { decision: 'denied', outcome: 'not_run', reason };
}

function errorReason(error: unknown): string {
  if (!(error instanceof Error) || !error.message) {
    return 'computer_use_driver_failed';
  }
  const [code] = error.message.split(':');
  return code || 'computer_use_driver_failed';
}
