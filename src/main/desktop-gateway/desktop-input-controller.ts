import type {
  DesktopAccessibilitySnapshotResult,
  DesktopActionResult,
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopGatewayContext,
  DesktopGatewayResult,
  DesktopHotkeyRequest,
  DesktopInputActionRequest,
  DesktopScrollRequest,
  DesktopTypeTextRequest,
  DesktopWaitForRequest,
  DesktopWaitForResult,
} from '../../shared/types/desktop-gateway.types';
import {
  grantAllowsInput,
  type DesktopPermissionGrant,
} from './desktop-grant-store';
import { redactDesktopMetadata } from './desktop-redaction';
import type { DesktopSessionLock } from './desktop-session-lock';
import type { DesktopDriver } from './platform/desktop-driver';

interface DesktopInputControllerDeps {
  driver: DesktopDriver;
  sessionLock: DesktopSessionLock;
  requireApprovalForInput: () => boolean;
  now: () => number;
  requireObservableApp: (
    context: DesktopGatewayContext,
    toolName: string,
    appId: string | undefined,
  ) => Promise<{ app?: DesktopAppDescriptor; grantId?: string; reason?: string }>;
  validateObservationToken: (token: string, appId: string) => string | null;
  createObservationToken: (appId: string) => string;
  findActiveGrant: (
    context: DesktopGatewayContext,
    appId: string,
    predicate: (grant: DesktopPermissionGrant) => boolean,
  ) => Promise<DesktopPermissionGrant | null>;
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

export class DesktopInputController {
  constructor(private readonly deps: DesktopInputControllerDeps) {}

  async click(
    context: DesktopGatewayContext,
    request: DesktopClickRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.runInputAction(context, 'computer.click', request, () => this.deps.driver.click(request));
  }

  async typeText(
    context: DesktopGatewayContext,
    request: DesktopTypeTextRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.runInputAction(context, 'computer.type_text', request, () => this.deps.driver.typeText(request));
  }

  async hotkey(
    context: DesktopGatewayContext,
    request: DesktopHotkeyRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    if (isDeniedHotkey(request.keys)) {
      await this.deps.audit(context, 'computer.hotkey', 'denied', 'not_run', 'computer_use_sensitive_action_blocked', metadataFromObject(request), request.appId);
      return denied('computer_use_sensitive_action_blocked');
    }
    return this.runInputAction(context, 'computer.hotkey', request, () => this.deps.driver.hotkey(request));
  }

  async scroll(
    context: DesktopGatewayContext,
    request: DesktopScrollRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.runInputAction(context, 'computer.scroll', request, () => this.deps.driver.scroll(request));
  }

  async drag(
    context: DesktopGatewayContext,
    request: DesktopDragRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    return this.runInputAction(context, 'computer.drag', request, () => this.deps.driver.drag(request));
  }

  async waitFor(
    context: DesktopGatewayContext,
    request: DesktopWaitForRequest,
  ): Promise<DesktopGatewayResult<DesktopWaitForResult>> {
    const policy = await this.deps.requireObservableApp(context, 'computer.wait_for', request.appId);
    if (policy.reason || !policy.app) {
      return denied(policy.reason ?? 'computer_use_target_not_found');
    }
    const deadline = this.deps.now() + (request.timeoutMs ?? 5_000);
    do {
      try {
        const snapshot = await this.deps.driver.accessibilitySnapshot({
          appId: policy.app.appId,
          includeBounds: true,
          maxNodes: 500,
        });
        if (matchesWaitCondition(snapshot.nodes, request.condition)) {
          const token = this.deps.createObservationToken(snapshot.appId);
          await this.deps.audit(context, 'computer.wait_for', 'allowed', 'ok', undefined, metadataFromObject(request), policy.app.appId, policy.grantId);
          return allowed({
            matched: true,
            explanation: 'Matched accessibility snapshot condition',
            appId: snapshot.appId,
            observationToken: token,
          });
        }
      } catch (error) {
        const reason = errorReason(error, 'computer_use_driver_failed');
        await this.deps.audit(context, 'computer.wait_for', 'denied', 'failed', reason, metadataFromObject(request), policy.app.appId, policy.grantId);
        return denied(reason, 'failed');
      }
      await sleep(100);
    } while (this.deps.now() < deadline);
    await this.deps.audit(context, 'computer.wait_for', 'denied', 'failed', 'computer_use_wait_timeout', metadataFromObject(request), policy.app.appId, policy.grantId);
    return denied('computer_use_wait_timeout', 'failed');
  }

  private async runInputAction(
    context: DesktopGatewayContext,
    toolName: string,
    request: DesktopInputActionRequest,
    driverAction: () => Promise<DesktopActionResult>,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const readiness = await this.requireInputAction(context, toolName, request);
    if (readiness.reason || !readiness.app) {
      return denied(readiness.reason ?? 'computer_use_target_not_found');
    }
    const lock = await this.deps.sessionLock.acquire({
      instanceId: context.instanceId,
      ...(context.provider ? { provider: context.provider } : {}),
      appId: readiness.app.appId,
    });
    if (lock.kind === 'blocked') {
      await this.deps.audit(context, toolName, 'denied', 'not_run', 'computer_use_lock_held', {
        holder: lock.holder,
      }, readiness.app.appId, readiness.grantId);
      return denied('computer_use_lock_held');
    }
    try {
      const result = await driverAction();
      if (result.appId && result.appId !== readiness.app.appId) {
        await this.deps.audit(context, toolName, 'denied', 'failed', 'computer_use_target_changed', {
          expectedAppId: readiness.app.appId,
          actualAppId: result.appId,
        }, readiness.app.appId, readiness.grantId);
        return denied('computer_use_target_changed', 'failed');
      }
      const data = {
        ...result,
        appId: result.appId ?? readiness.app.appId,
        completedAt: result.completedAt ?? this.deps.now(),
      };
      await this.deps.audit(context, toolName, 'allowed', 'ok', undefined, metadataFromObject(request), readiness.app.appId, readiness.grantId);
      return allowed(data);
    } catch (error) {
      const reason = errorReason(error, 'computer_use_driver_failed');
      await this.deps.audit(context, toolName, 'denied', 'failed', reason, metadataFromObject(request), readiness.app.appId, readiness.grantId);
      return denied(reason, 'failed');
    } finally {
      await lock.release();
    }
  }

  private async requireInputAction(
    context: DesktopGatewayContext,
    toolName: string,
    request: DesktopInputActionRequest,
  ): Promise<{ app?: DesktopAppDescriptor; grantId?: string; reason?: string }> {
    const policy = await this.deps.requireObservableApp(context, toolName, request.appId);
    if (policy.reason || !policy.app) {
      return policy;
    }
    const tokenReason = this.deps.validateObservationToken(request.observationToken, policy.app.appId);
    if (tokenReason) {
      await this.deps.audit(context, toolName, 'denied', 'not_run', tokenReason, metadataFromObject(request), policy.app.appId, policy.grantId);
      return { app: policy.app, reason: tokenReason };
    }
    if (request.sensitive || isSecretLikeInput(request)) {
      await this.deps.audit(context, toolName, 'denied', 'not_run', 'computer_use_sensitive_action_blocked', metadataFromObject(request), policy.app.appId, policy.grantId);
      return { app: policy.app, reason: 'computer_use_sensitive_action_blocked' };
    }
    const grant = await this.deps.findActiveGrant(context, policy.app.appId, grantAllowsInput);
    if (!grant && this.deps.requireApprovalForInput()) {
      await this.deps.audit(context, toolName, 'denied', 'not_run', 'computer_use_grant_required', metadataFromObject(request), policy.app.appId, policy.grantId);
      return { app: policy.app, reason: 'computer_use_grant_required' };
    }
    return {
      app: policy.app,
      grantId: grant?.id ?? policy.grantId,
    };
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

function isDeniedHotkey(keys: string[]): boolean {
  const normalized = new Set(keys.map((key) => key.trim().toLowerCase()));
  const hasCommand = normalized.has('cmd') || normalized.has('command') || normalized.has('meta');
  if (hasCommand && normalized.has('q')) {
    return true;
  }
  if (hasCommand && normalized.has('option') && normalized.has('escape')) {
    return true;
  }
  const hasControl = normalized.has('ctrl') || normalized.has('control');
  return hasControl && hasCommand && (
    normalized.has('power')
    || normalized.has('eject')
    || normalized.has('delete')
  );
}

function isSecretLikeInput(request: DesktopInputActionRequest): boolean {
  if (!('text' in request) || typeof request.text !== 'string') {
    return false;
  }
  const text = request.text.trim();
  if (/^(sk-|xox[baprs]-|gh[pousr]_)/i.test(text)) {
    return true;
  }
  const noWhitespace = !/\s/.test(text);
  const hasLetters = /[a-z]/i.test(text);
  const hasDigits = /\d/.test(text);
  const hasSymbols = /[^a-z0-9]/i.test(text);
  return text.length >= 48 && noWhitespace && hasLetters && hasDigits && hasSymbols;
}

function matchesWaitCondition(
  nodes: DesktopAccessibilitySnapshotResult['nodes'],
  condition: DesktopWaitForRequest['condition'],
): boolean {
  for (const node of nodes) {
    const nodeText = [node.label, node.value].filter(Boolean).join(' ');
    if (condition.text && nodeText.includes(condition.text)) {
      return true;
    }
    if (condition.label && node.label?.includes(condition.label)) {
      return true;
    }
    if (condition.role && node.role === condition.role) {
      return true;
    }
    if (node.children && matchesWaitCondition(node.children, condition)) {
      return true;
    }
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
