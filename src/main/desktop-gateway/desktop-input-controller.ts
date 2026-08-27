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
import type { ResolvedComputerUseAutonomy } from '../instance/lifecycle/computer-use-scoping';
import { isSensitiveObservedElement } from './desktop-action-classifier';
import { activateObservedWindow } from './desktop-window-activation';
import {
  grantAllowsInput,
  type DesktopPermissionGrant,
} from './desktop-grant-store';
import type { DesktopSessionLock } from './desktop-session-lock';
import type { DesktopDriver } from './platform/desktop-driver';
import {
  annotateInputEligibility,
  findApprovedWindowBounds,
} from './desktop-accessibility-actionability';
import { normalizeDesktopWindowId } from './desktop-window-identity';
import {
  isDeniedHotkeyAtLevel,
  isSecretLikeInput,
  matchesWaitCondition,
} from './desktop-input-policy';
import { withResolvedComputerUseAutonomy } from './desktop-computer-use-policy';

interface DesktopInputControllerDeps {
  driver: DesktopDriver;
  sessionLock: DesktopSessionLock;
  requireApprovalForInput: () => boolean;
  autonomy: (context: DesktopGatewayContext) => ResolvedComputerUseAutonomy;
  now: () => number;
  requireObservableApp: (
    context: DesktopGatewayContext,
    toolName: string,
    appId: string | undefined,
    autonomy?: ResolvedComputerUseAutonomy,
  ) => Promise<{ app?: DesktopAppDescriptor; grantId?: string; reason?: string; autonomy: ResolvedComputerUseAutonomy }>;
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
    const autonomy = this.deps.autonomy(context);
    const resolved = await this.resolveObservedPoint(context, 'computer.click', request, autonomy);
    if (!resolved.ok) {
      return denied(resolved.reason);
    }
    return this.runInputAction(
      context,
      'computer.click',
      resolved.request,
      (request) => this.deps.driver.click(request),
      autonomy,
    );
  }

  async typeText(
    context: DesktopGatewayContext,
    request: DesktopTypeTextRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const autonomy = this.deps.autonomy(context);
    const resolved = await this.resolveTextTarget(context, request, autonomy);
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
    }, autonomy);
  }

  async hotkey(
    context: DesktopGatewayContext,
    request: DesktopHotkeyRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const autonomy = this.deps.autonomy(context);
    if (isDeniedHotkeyAtLevel(request.keys, autonomy.level)) {
      await this.deps.audit(context, 'computer.hotkey', 'denied', 'not_run', 'computer_use_sensitive_action_blocked', { ...metadataFromObject(request), autonomyLevel: autonomy.level, autonomySource: autonomy.source }, request.appId);
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
        request.appId,
      );
      return denied(observed.reason);
    }
    if (observed.candidate.inputEligible === false) {
      const reason = 'computer_use_target_outside_approved_window';
      await this.deps.audit(
        context,
        'computer.hotkey',
        'denied',
        'not_run',
        reason,
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
        request.appId,
      );
      return denied(reason);
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
      autonomy,
    );
  }

  async scroll(
    context: DesktopGatewayContext,
    request: DesktopScrollRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const autonomy = this.deps.autonomy(context);
    const resolved = await this.resolveObservedPoint(context, 'computer.scroll', request, autonomy);
    if (!resolved.ok) {
      return denied(resolved.reason);
    }
    return this.runInputAction(
      context,
      'computer.scroll',
      resolved.request,
      (boundRequest) => this.deps.driver.scroll(boundRequest),
      autonomy,
    );
  }

  async drag(
    context: DesktopGatewayContext,
    request: DesktopDragRequest,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const autonomy = this.deps.autonomy(context);
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
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
      autonomy,
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
    const autonomy = this.deps.autonomy(context);
    return activateObservedWindow(context, request, {
      driver: this.deps.driver,
      requireObservableApp: (targetContext, toolName, appId) =>
        this.deps.requireObservableApp(targetContext, toolName, appId, autonomy),
      validateObservationToken: this.deps.validateObservationToken,
      getObservationWindowId: this.deps.getObservationWindowId,
      audit: this.deps.audit,
    });
  }

  async waitFor(
    context: DesktopGatewayContext,
    request: DesktopWaitForRequest,
  ): Promise<DesktopGatewayResult<DesktopWaitForResult>> {
    const autonomy = this.deps.autonomy(context);
    const policy = await this.deps.requireObservableApp(
      context,
      'computer.wait_for',
      request.appId,
      autonomy,
    );
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
          const observedWindowId = normalizeDesktopWindowId(
            snapshot.windowId,
            policy.app.windowId,
          ) ?? policy.app.windowId;
          if (
            snapshot.appId !== policy.app.appId
            || !observedWindowId
            || (policy.app.windowId && observedWindowId !== policy.app.windowId)
          ) {
            await this.deps.audit(
              context,
              'computer.wait_for',
              'denied',
              'failed',
              'computer_use_target_changed',
              withResolvedComputerUseAutonomy(policy.autonomy, metadataFromObject(request)),
              policy.app.appId,
              policy.grantId,
            );
            return denied('computer_use_target_changed', 'failed');
          }
          const windowBounds = findApprovedWindowBounds(policy.app, observedWindowId);
          const nodes = windowBounds
            ? annotateInputEligibility(snapshot.nodes, windowBounds)
            : snapshot.nodes;
          const token = this.deps.createObservationToken(snapshot.appId, {
            windowId: observedWindowId,
            snapshot: nodes,
          });
          await this.deps.audit(context, 'computer.wait_for', 'allowed', 'ok', undefined, withResolvedComputerUseAutonomy(policy.autonomy, metadataFromObject(request)), policy.app.appId, policy.grantId);
          return allowed({
            matched: true,
            explanation: 'Matched accessibility snapshot condition',
            appId: snapshot.appId,
            observationToken: token,
          });
        }
      } catch (error) {
        const reason = errorReason(error, 'computer_use_driver_failed');
        await this.deps.audit(context, 'computer.wait_for', 'denied', 'failed', reason, withResolvedComputerUseAutonomy(policy.autonomy, metadataFromObject(request)), policy.app.appId, policy.grantId);
        return denied(reason, 'failed');
      }
      await sleep(100);
    } while (this.deps.now() < deadline);
    await this.deps.audit(context, 'computer.wait_for', 'denied', 'failed', 'computer_use_wait_timeout', withResolvedComputerUseAutonomy(policy.autonomy, metadataFromObject(request)), policy.app.appId, policy.grantId);
    return denied('computer_use_wait_timeout', 'failed');
  }

  private async runInputAction<TRequest extends DesktopInputActionRequest>(
    context: DesktopGatewayContext,
    toolName: string,
    request: TRequest,
    driverAction: (request: TRequest) => Promise<DesktopActionResult>,
    autonomy: ResolvedComputerUseAutonomy,
  ): Promise<DesktopGatewayResult<DesktopActionResult>> {
    const readiness = await this.requireInputAction(context, toolName, request, autonomy);
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
      await this.deps.audit(context, toolName, 'denied', 'not_run', 'computer_use_lock_held', withResolvedComputerUseAutonomy(autonomy, {
        holder: lock.holder,
      }), readiness.app.appId, readiness.grantId);
      return denied('computer_use_lock_held');
    }
    try {
      const result = await driverAction(boundRequest);
      if (result.appId && result.appId !== readiness.app.appId) {
        await this.deps.audit(context, toolName, 'denied', 'failed', 'computer_use_target_changed', withResolvedComputerUseAutonomy(autonomy, {
          expectedAppId: readiness.app.appId,
          actualAppId: result.appId,
        }), readiness.app.appId, readiness.grantId);
        return denied('computer_use_target_changed', 'failed');
      }
      const data = {
        ...result,
        appId: result.appId ?? readiness.app.appId,
        completedAt: result.completedAt ?? this.deps.now(),
      };
      await this.deps.audit(context, toolName, 'allowed', 'ok', undefined, withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)), readiness.app.appId, readiness.grantId);
      return allowed(data);
    } catch (error) {
      const reason = errorReason(error, 'computer_use_driver_failed');
      await this.deps.audit(context, toolName, 'denied', 'failed', reason, withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)), readiness.app.appId, readiness.grantId);
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
    autonomy: ResolvedComputerUseAutonomy,
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
        request.appId,
      );
      return { ok: false, reason: observed.reason };
    }
    if (observed.candidate.inputEligible === false) {
      const reason = 'computer_use_target_outside_approved_window';
      await this.deps.audit(
        context,
        toolName,
        'denied',
        'not_run',
        reason,
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
        request.appId,
      );
      return { ok: false, reason };
    }
    if (request.elementUid && !observed.candidate.bounds) {
      const reason = 'computer_use_element_bounds_unavailable';
      await this.deps.audit(
        context,
        toolName,
        'denied',
        'not_run',
        reason,
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
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
    autonomy: ResolvedComputerUseAutonomy,
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
        request.appId,
      );
      return { ok: false, reason: observed.reason };
    }
    if (observed.candidate.inputEligible === false) {
      const reason = 'computer_use_target_outside_approved_window';
      await this.deps.audit(
        context,
        'computer.type_text',
        'denied',
        'not_run',
        reason,
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
        request.appId,
      );
      return { ok: false, reason };
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
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
    autonomy: ResolvedComputerUseAutonomy,
  ): Promise<{
    app?: DesktopAppDescriptor;
    grantId?: string;
    observationWindowId?: string;
    reason?: string;
  }> {
    const policy = await this.deps.requireObservableApp(
      context,
      toolName,
      request.appId,
      autonomy,
    );
    if (policy.reason || !policy.app) {
      return policy;
    }
    const tokenReason = this.deps.validateObservationToken(
      request.observationToken,
      policy.app.appId,
      policy.app.windowId,
    );
    if (tokenReason) {
      await this.deps.audit(context, toolName, 'denied', 'not_run', tokenReason, withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)), policy.app.appId, policy.grantId);
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
        withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)),
        policy.app.appId,
        policy.grantId,
      );
      return { app: policy.app, reason };
    }
    if (autonomy.level === 'guarded' && (request.sensitive || isSecretLikeInput(request))) {
      await this.deps.audit(context, toolName, 'denied', 'not_run', 'computer_use_sensitive_action_blocked', withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)), policy.app.appId, policy.grantId);
      return { app: policy.app, reason: 'computer_use_sensitive_action_blocked' };
    }
    const grant = await this.deps.findActiveGrant(context, policy.app.appId, grantAllowsInput);
    if (!grant && this.deps.requireApprovalForInput()) {
      await this.deps.audit(context, toolName, 'denied', 'not_run', 'computer_use_grant_required', withResolvedComputerUseAutonomy(autonomy, metadataFromObject(request)), policy.app.appId, policy.grantId);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
