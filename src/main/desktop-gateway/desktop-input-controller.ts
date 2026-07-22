import type {
  DesktopAccessibilitySnapshotResult,
  DesktopActionResult,
  DesktopActivateWindowRequest,
  DesktopActivateWindowResult,
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopElementCandidate,
  DesktopGatewayContext,
  DesktopGatewayResult,
  DesktopHotkeyRequest,
  DesktopInputActionRequest,
  DesktopPoint,
  DesktopScrollRequest,
  DesktopTypeTextRequest,
  DesktopWaitForRequest,
  DesktopWaitForResult,
} from '../../shared/types/desktop-gateway.types';
import { isSensitiveObservedElement } from './desktop-action-classifier';
import { activateObservedWindow } from './desktop-window-activation';
import {
  grantAllowsInput,
  type DesktopPermissionGrant,
} from './desktop-grant-store';
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
  validateObservationToken: (
    token: string,
    appId: string,
    currentWindowId?: string,
  ) => string | null;
  getObservationWindowId: (token: string, appId: string) => string | undefined;
  findObservedElement: (
    token: string,
    appId: string,
    uid: string,
  ) => { ok: true; candidate: DesktopElementCandidate } | { ok: false; reason: string };
  findFocusedObservedElement: (
    token: string,
    appId: string,
  ) => { ok: true; candidate: DesktopElementCandidate } | { ok: false; reason: string };
  findObservedElementAtPoint: (
    token: string,
    appId: string,
    point: DesktopPoint,
  ) => { ok: true; candidate: DesktopElementCandidate } | { ok: false; reason: string };
  createObservationToken: (
    appId: string,
    meta?: {
      windowId?: string;
      snapshot?: DesktopAccessibilitySnapshotResult['nodes'];
    },
  ) => string;
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
    const resolved = await this.resolveObservedPoint(context, 'computer.click', request);
    if (!resolved.ok) {
      return denied(resolved.reason);
    }
    return this.runInputAction(
      context,
      'computer.click',
      resolved.request,
      (request) => this.deps.driver.click(request),
    );
  }

  async typeText(
    context: DesktopGatewayContext,
    request: DesktopTypeTextRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const resolved = await this.resolveTextTarget(context, request);
    if (!resolved.ok) {
      return denied(resolved.reason);
    }
    return this.runInputAction(context, 'computer.type_text', resolved.request, async (request) => {
      if (resolved.point) {
        await this.deps.driver.click({
          appId: request.appId,
          observationToken: request.observationToken,
          windowId: request.windowId,
          elementUid: request.elementUid,
          ...resolved.point,
        });
      }
      return this.deps.driver.typeText(request);
    });
  }

  async hotkey(
    context: DesktopGatewayContext,
    request: DesktopHotkeyRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    if (isDeniedHotkey(request.keys)) {
      await this.deps.audit(context, 'computer.hotkey', 'denied', 'not_run', 'computer_use_sensitive_action_blocked', metadataFromObject(request), request.appId);
      return denied('computer_use_sensitive_action_blocked');
    }
    const observed = this.deps.findFocusedObservedElement(
      request.observationToken,
      request.appId,
    );
    if (!observed.ok) {
      await this.deps.audit(
        context,
        'computer.hotkey',
        'denied',
        'not_run',
        observed.reason,
        metadataFromObject(request),
        request.appId,
      );
      return denied(observed.reason);
    }
    const resolvedRequest = {
      ...request,
      ...(isSensitiveObservedElement(observed.candidate) ? { sensitive: true } : {}),
    };
    return this.runInputAction(
      context,
      'computer.hotkey',
      resolvedRequest,
      (boundRequest) => this.deps.driver.hotkey(boundRequest),
    );
  }

  async scroll(
    context: DesktopGatewayContext,
    request: DesktopScrollRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const resolved = await this.resolveObservedPoint(context, 'computer.scroll', request);
    if (!resolved.ok) {
      return denied(resolved.reason);
    }
    return this.runInputAction(
      context,
      'computer.scroll',
      resolved.request,
      (boundRequest) => this.deps.driver.scroll(boundRequest),
    );
  }

  async drag(
    context: DesktopGatewayContext,
    request: DesktopDragRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const start = this.deps.findObservedElementAtPoint(
      request.observationToken,
      request.appId,
      request.start,
    );
    const end = this.deps.findObservedElementAtPoint(
      request.observationToken,
      request.appId,
      request.end,
    );
    if (!start.ok) {
      await this.deps.audit(
        context,
        'computer.drag',
        'denied',
        'not_run',
        start.reason,
        metadataFromObject(request),
        request.appId,
      );
      return denied(start.reason);
    }
    if (!end.ok) {
      await this.deps.audit(
        context,
        'computer.drag',
        'denied',
        'not_run',
        end.reason,
        metadataFromObject(request),
        request.appId,
      );
      return denied(end.reason);
    }
    const sensitive = isSensitiveObservedElement(start.candidate)
      || isSensitiveObservedElement(end.candidate);
    const resolvedRequest = { ...request, ...(sensitive ? { sensitive: true } : {}) };
    return this.runInputAction(
      context,
      'computer.drag',
      resolvedRequest,
      (boundRequest) => this.deps.driver.drag(boundRequest),
    );
  }

  /**
   * Bring an already-observed window of an already-granted app to the front.
   * Delegated so the policy rules live beside their own tests; see
   * desktop-window-activation.ts for why each guard exists.
   */
  activateWindow(
    context: DesktopGatewayContext,
    request: DesktopActivateWindowRequest,
  ): Promise<DesktopGatewayResult<DesktopActivateWindowResult>> {
    return activateObservedWindow(context, request, {
      driver: this.deps.driver,
      requireObservableApp: this.deps.requireObservableApp,
      validateObservationToken: this.deps.validateObservationToken,
      getObservationWindowId: this.deps.getObservationWindowId,
      audit: this.deps.audit,
    });
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
          ...(policy.app.windowId ? { windowId: policy.app.windowId } : {}),
          includeBounds: true,
          maxNodes: 500,
        });
        if (matchesWaitCondition(snapshot.nodes, request.condition)) {
          const observedWindowId = snapshot.windowId ?? policy.app.windowId;
          if (
            snapshot.appId !== policy.app.appId
            || !observedWindowId
            || (policy.app.windowId
              && snapshot.windowId
              && snapshot.windowId !== policy.app.windowId)
          ) {
            await this.deps.audit(
              context,
              'computer.wait_for',
              'denied',
              'failed',
              'computer_use_target_changed',
              metadataFromObject(request),
              policy.app.appId,
              policy.grantId,
            );
            return denied('computer_use_target_changed', 'failed');
          }
          const token = this.deps.createObservationToken(snapshot.appId, {
            windowId: observedWindowId,
            snapshot: snapshot.nodes,
          });
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

  private async runInputAction<TRequest extends DesktopInputActionRequest>(
    context: DesktopGatewayContext,
    toolName: string,
    request: TRequest,
    driverAction: (request: TRequest) => Promise<DesktopActionResult>,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const readiness = await this.requireInputAction(context, toolName, request);
    if (readiness.reason || !readiness.app) {
      return denied(readiness.reason ?? 'computer_use_target_not_found');
    }
    const boundRequest = {
      ...request,
      windowId: readiness.observationWindowId,
    };
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
      const result = await driverAction(boundRequest);
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

  private async resolveObservedPoint<
    TRequest extends DesktopInputActionRequest & {
      elementUid?: string;
      x?: number;
      y?: number;
    },
  >(
    context: DesktopGatewayContext,
    toolName: string,
    request: TRequest,
  ): Promise<
    | { ok: true; request: TRequest; point?: { x: number; y: number } }
    | { ok: false; reason: string }
  > {
    const observed = request.elementUid
      ? this.deps.findObservedElement(
        request.observationToken,
        request.appId,
        request.elementUid,
      )
      : request.x !== undefined && request.y !== undefined
        ? this.deps.findObservedElementAtPoint(
          request.observationToken,
          request.appId,
          { x: request.x, y: request.y },
        )
        : null;
    if (!observed) {
      const reason = 'computer_use_element_target_required';
      await this.deps.audit(
        context,
        toolName,
        'denied',
        'not_run',
        reason,
        metadataFromObject(request),
        request.appId,
      );
      return { ok: false, reason };
    }
    if (!observed.ok) {
      await this.deps.audit(
        context,
        toolName,
        'denied',
        'not_run',
        observed.reason,
        metadataFromObject(request),
        request.appId,
      );
      return { ok: false, reason: observed.reason };
    }
    if (request.elementUid && !observed.candidate.bounds) {
      const reason = 'computer_use_element_bounds_unavailable';
      await this.deps.audit(
        context,
        toolName,
        'denied',
        'not_run',
        reason,
        metadataFromObject(request),
        request.appId,
      );
      return { ok: false, reason };
    }
    const point = request.elementUid
      ? {
        x: observed.candidate.bounds!.x + observed.candidate.bounds!.width / 2,
        y: observed.candidate.bounds!.y + observed.candidate.bounds!.height / 2,
      }
      : { x: request.x!, y: request.y! };
    const pointObserved = request.elementUid
      ? this.deps.findObservedElementAtPoint(
        request.observationToken,
        request.appId,
        point,
      )
      : observed;
    if (!pointObserved.ok) {
      await this.deps.audit(
        context,
        toolName,
        'denied',
        'not_run',
        pointObserved.reason,
        metadataFromObject(request),
        request.appId,
      );
      return { ok: false, reason: pointObserved.reason };
    }
    const sensitive = isSensitiveObservedElement(observed.candidate)
      || isSensitiveObservedElement(pointObserved.candidate);
    return {
      ok: true,
      request: {
        ...request,
        ...point,
        ...(sensitive ? { sensitive: true } : {}),
      },
      point,
    };
  }

  private async resolveTextTarget(
    context: DesktopGatewayContext,
    request: DesktopTypeTextRequest,
  ): Promise<
    | { ok: true; request: DesktopTypeTextRequest; point?: { x: number; y: number } }
    | { ok: false; reason: string }
  > {
    const observed = request.elementUid
      ? this.deps.findObservedElement(request.observationToken, request.appId, request.elementUid)
      : this.deps.findFocusedObservedElement(request.observationToken, request.appId);
    if (!observed.ok) {
      await this.deps.audit(
        context,
        'computer.type_text',
        'denied',
        'not_run',
        observed.reason,
        metadataFromObject(request),
        request.appId,
      );
      return { ok: false, reason: observed.reason };
    }
    if (!request.elementUid) {
      return {
        ok: true,
        request: {
          ...request,
          ...(isSensitiveObservedElement(observed.candidate) ? { sensitive: true } : {}),
        },
      };
    }
    if (!observed.candidate.bounds) {
      const reason = 'computer_use_element_bounds_unavailable';
      await this.deps.audit(
        context,
        'computer.type_text',
        'denied',
        'not_run',
        reason,
        metadataFromObject(request),
        request.appId,
      );
      return { ok: false, reason };
    }
    const point = {
      x: observed.candidate.bounds.x + observed.candidate.bounds.width / 2,
      y: observed.candidate.bounds.y + observed.candidate.bounds.height / 2,
    };
    const pointObserved = this.deps.findObservedElementAtPoint(
      request.observationToken,
      request.appId,
      point,
    );
    if (!pointObserved.ok) {
      await this.deps.audit(
        context,
        'computer.type_text',
        'denied',
        'not_run',
        pointObserved.reason,
        metadataFromObject(request),
        request.appId,
      );
      return { ok: false, reason: pointObserved.reason };
    }
    const sensitive = isSensitiveObservedElement(observed.candidate)
      || isSensitiveObservedElement(pointObserved.candidate);
    return {
      ok: true,
      request: {
        ...request,
        ...(sensitive ? { sensitive: true } : {}),
      },
      point,
    };
  }

  private async requireInputAction(
    context: DesktopGatewayContext,
    toolName: string,
    request: DesktopInputActionRequest,
  ): Promise<{
    app?: DesktopAppDescriptor;
    grantId?: string;
    observationWindowId?: string;
    reason?: string;
  }> {
    const policy = await this.deps.requireObservableApp(context, toolName, request.appId);
    if (policy.reason || !policy.app) {
      return policy;
    }
    const tokenReason = this.deps.validateObservationToken(
      request.observationToken,
      policy.app.appId,
      policy.app.windowId,
    );
    if (tokenReason) {
      await this.deps.audit(context, toolName, 'denied', 'not_run', tokenReason, metadataFromObject(request), policy.app.appId, policy.grantId);
      return { app: policy.app, reason: tokenReason };
    }
    const observationWindowId = this.deps.getObservationWindowId(
      request.observationToken,
      policy.app.appId,
    );
    if (!observationWindowId) {
      const reason = 'computer_use_target_changed';
      await this.deps.audit(
        context,
        toolName,
        'denied',
        'not_run',
        reason,
        metadataFromObject(request),
        policy.app.appId,
        policy.grantId,
      );
      return { app: policy.app, reason };
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
      observationWindowId,
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
  if (normalized.has('enter') || normalized.has('return') || normalized.has('space')) {
    return true;
  }
  const hasCommand = normalized.has('cmd') || normalized.has('command') || normalized.has('meta');
  if (hasCommand && normalized.has('q')) {
    return true;
  }
  if (hasCommand && normalized.has('option') && normalized.has('escape')) {
    return true;
  }
  const hasControl = normalized.has('ctrl') || normalized.has('control');
  if ((hasCommand || normalized.has('shift'))
    && (normalized.has('delete') || normalized.has('backspace'))) {
    return true;
  }
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
