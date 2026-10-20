import { emitPluginHook } from '../plugins/hook-emitter';
import {
  getSessionAdmissionService,
  type AdmissionOutcome,
  type RedeliveryContext,
  type SuppressReason,
} from '../session/session-admission-service';
import { getLogger } from '../logging/logger';
import { formatCommandResponse, type OrchestratorAction } from './orchestration-protocol';

const logger = getLogger('OrchestrationResponseDelivery');

/**
 * Confirm-callback error for a response that was not delivered for a reason
 * that passes, so it is queued again instead of failing: the provider refused
 * it on a usage limit a park or account switch now owns (`provider-limited`),
 * or an account switch replaced the adapter before it was sent (`respawning`).
 */
export class OrchestrationResponseHeldError extends Error {
  constructor(message: string, readonly reason: 'provider-limited' | 'respawning' = 'provider-limited') {
    super(message);
    this.name = 'OrchestrationResponseHeldError';
  }
}

export function isParentUnavailableSuppression(reason: SuppressReason): boolean {
  return reason === 'respawning' || reason === 'terminal' || reason === 'unknown-instance';
}

export interface OrchestrationResponseDeliveryOptions {
  emit: (instanceId: string, response: string, confirm: (error?: Error) => void) => void;
  onChildCompletionRedelivered: (parentId: string, childId: string) => void;
  /**
   * A child completion requeued because its parent was respawning, so restart
   * reconciliation can account for it. A limit-held one is not reported: like
   * an awaiting-human suppression, it is still delivered later.
   */
  onChildCompletionRequeuedForRespawn?: (parentId: string, childId: string, admissionId: string) => void;
}

/** Admission, redelivery, audit hooks, and final emission for command responses. */
export class OrchestrationResponseDelivery {
  constructor(private readonly options: OrchestrationResponseDeliveryOptions) {
    getSessionAdmissionService().registerRedeliveryHandler(
      'orchestration',
      (ctx) => this.handleRedelivery(ctx),
    );
  }

  inject(
    instanceId: string,
    action: string,
    success: boolean,
    data: unknown,
    options: { alreadyAdmitted?: boolean; admissionId?: string; onDelivered?: () => void } = {},
  ): AdmissionOutcome | null {
    const response = formatCommandResponse(action as OrchestratorAction, success, data);
    const request = {
      instanceId,
      origin: 'orchestration' as const,
      message: response,
      sourceMetadata: { action, success, data },
    };
    let admission: AdmissionOutcome | null = null;
    if (!options.alreadyAdmitted) {
      const outcome = getSessionAdmissionService().admitAutomatedWrite(request);
      if (outcome.kind === 'suppressed') {
        logger.warn('Orchestration response injection suppressed pending instance readiness', {
          instanceId,
          action,
          reason: outcome.reason,
          admissionId: outcome.admissionId,
        });
        return outcome;
      }
      admission = outcome;
    }
    let confirmed = false;
    this.options.emit(instanceId, response, (error) => {
      if (confirmed) return;
      confirmed = true;
      const admissionId = admission?.admissionId ?? options.admissionId;
      if (error instanceof OrchestrationResponseHeldError) {
        const requeuedId = getSessionAdmissionService().requeueUndelivered(admissionId, request, error.reason);
        const childId = action === 'child_completed' ? childIdFromResponseData(data) : null;
        if (error.reason === 'respawning' && childId && requeuedId) {
          this.options.onChildCompletionRequeuedForRespawn?.(instanceId, childId, requeuedId);
        }
        return;
      }
      if (error) {
        if (admissionId) getSessionAdmissionService().markFailed(admissionId, error.message);
        return;
      }
      if (admissionId) getSessionAdmissionService().markDelivered(admissionId);
      this.emitAuditHook(instanceId, action, success, data);
      options.onDelivered?.();
    });
    return admission;
  }

  private handleRedelivery(ctx: RedeliveryContext): void {
    const meta = ctx.sourceMetadata as {
      action?: string;
      success?: boolean;
      data?: unknown;
    } | undefined;
    if (!meta?.action) {
      logger.warn('Orchestration redelivery missing response metadata; dropping', {
        instanceId: ctx.instanceId,
        admissionId: ctx.admissionId,
      });
      getSessionAdmissionService().markFailed(
        ctx.admissionId,
        'Orchestration redelivery missing response metadata',
      );
      return;
    }
    const childId = meta.action === 'child_completed'
      ? childIdFromResponseData(meta.data)
      : null;
    this.inject(ctx.instanceId, meta.action, Boolean(meta.success), meta.data, {
      alreadyAdmitted: true,
      admissionId: ctx.admissionId,
      onDelivered: () => {
        if (childId) this.options.onChildCompletionRedelivered(ctx.instanceId, childId);
      },
    });
  }

  private emitAuditHook(
    instanceId: string,
    action: string,
    success: boolean,
    data: unknown,
  ): void {
    const payload = { instanceId, action, data, timestamp: Date.now() };
    if (success) {
      emitPluginHook('orchestration.command.completed', payload);
      return;
    }
    const error = typeof data === 'object' && data !== null && 'error' in data
      ? String((data as Record<string, unknown>)['error'])
      : undefined;
    emitPluginHook('orchestration.command.failed', { ...payload, error });
  }
}

function childIdFromResponseData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const childId = (data as Record<string, unknown>)['childId'];
  return typeof childId === 'string' && childId ? childId : null;
}
