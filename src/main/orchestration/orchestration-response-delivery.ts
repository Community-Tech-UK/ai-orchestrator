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

export function isParentUnavailableSuppression(reason: SuppressReason): boolean {
  return reason === 'respawning' || reason === 'terminal' || reason === 'unknown-instance';
}

export interface OrchestrationResponseDeliveryOptions {
  emit: (instanceId: string, response: string) => void;
  onChildCompletionRedelivered: (parentId: string, childId: string) => void;
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
    options: { alreadyAdmitted?: boolean } = {},
  ): AdmissionOutcome | null {
    const response = formatCommandResponse(action as OrchestratorAction, success, data);
    let admission: AdmissionOutcome | null = null;
    if (!options.alreadyAdmitted) {
      const outcome = getSessionAdmissionService().admitAutomatedWrite({
        instanceId,
        origin: 'orchestration',
        message: response,
        sourceMetadata: { action, success, data },
      });
      if (outcome.kind === 'suppressed') {
        logger.warn('Orchestration response injection suppressed pending instance readiness', {
          instanceId,
          action,
          reason: outcome.reason,
          admissionId: outcome.admissionId,
        });
        return outcome;
      }
      getSessionAdmissionService().markDelivered(outcome.admissionId);
      admission = outcome;
    }
    this.emitAuditHook(instanceId, action, success, data);
    this.options.emit(instanceId, response);
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
    this.inject(ctx.instanceId, meta.action, Boolean(meta.success), meta.data, {
      alreadyAdmitted: true,
    });
    const childId = meta.action === 'child_completed'
      ? childIdFromResponseData(meta.data)
      : null;
    if (childId) this.options.onChildCompletionRedelivered(ctx.instanceId, childId);
    getSessionAdmissionService().markDelivered(ctx.admissionId);
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
