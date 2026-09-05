import type {
  Automation,
  AutomationDestination,
  AutomationRun,
} from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import type { SessionRevivalService } from '../session/session-revival-service';
import type { AutomationStore } from './automation-store';
import { getSessionAdmissionService, type RedeliveryContext } from '../session/session-admission-service';

const logger = getLogger('ThreadWakeupRunner');

type ThreadDestination = Extract<AutomationDestination, { kind: 'thread' }>;
type InstanceInput = Pick<InstanceManager, 'sendInput'>;
type RevivalInput = Pick<SessionRevivalService, 'revive'>;
type WakeupStore = Pick<AutomationStore, 'attachInstance' | 'terminalizeRun'>;

export interface ThreadWakeupRequest {
  run: AutomationRun;
  automation: Automation;
  destination: ThreadDestination;
}

export class ThreadWakeupRunner {
  constructor(
    private readonly instanceManager: InstanceInput,
    private readonly revival: RevivalInput,
    private readonly store: WakeupStore,
    private readonly now = () => Date.now(),
  ) {
    // Best-effort nudge once the target instance is no longer parked (e.g. it
    // was waiting_for_permission when the original wakeup was suppressed).
    // The AutomationRun itself is already terminalized 'failed' by the time
    // this ever fires (see below) — this only tries the direct send again,
    // it does not resurrect the run.
    getSessionAdmissionService().registerRedeliveryHandler('automation', (ctx) => this.handleRedelivery(ctx));
  }

  async fireThreadWakeup(request: ThreadWakeupRequest): Promise<AutomationRun> {
    const { run, automation, destination } = request;
    const revived = await this.reviveTarget(automation, destination);

    if (revived.status === 'failed' || !revived.instanceId) {
      const reason = `Thread wakeup failed: ${revived.failureCode ?? 'target_missing'}${revived.error ? ` (${revived.error})` : ''}`;
      return this.fail(run, reason);
    }

    const instanceId = revived.instanceId;
    this.store.attachInstance(run.id, instanceId, this.now());

    // A5: re-check live instance state before firing into it — a revived
    // thread can still be waiting_for_permission/interrupting/quota-parked.
    const admission = getSessionAdmissionService().admitAutomatedWrite({
      instanceId,
      origin: 'automation',
      message: automation.action.prompt,
      attachments: automation.action.attachments,
      sourceMetadata: { automationId: automation.id, runId: run.id },
    });
    if (admission.kind === 'suppressed') {
      const reason = `Thread wakeup deferred: instance not ready to receive input (${admission.reason}).`;
      logger.warn('Thread wakeup send suppressed pending instance readiness', {
        automationId: automation.id,
        runId: run.id,
        instanceId,
        reason: admission.reason,
        admissionId: admission.admissionId,
      });
      return this.fail(run, reason);
    }

    try {
      await this.instanceManager.sendInput(
        instanceId,
        automation.action.prompt,
        automation.action.attachments,
        { automatedInput: true },
      );
      getSessionAdmissionService().markDelivered(admission.admissionId);
      const summary = `Wakeup prompt delivered to thread ${instanceId}.`;
      return this.terminalize(run, 'succeeded', undefined, summary);
    } catch (error) {
      getSessionAdmissionService().markFailed(
        admission.admissionId,
        error instanceof Error ? error.message : String(error),
      );
      const reason = `Thread wakeup send failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn('Thread wakeup send failed', {
        automationId: automation.id,
        runId: run.id,
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fail(run, reason);
    }
  }

  private handleRedelivery(ctx: RedeliveryContext): void {
    void this.instanceManager
      .sendInput(ctx.instanceId, ctx.message, ctx.attachments, { automatedInput: true })
      .then(() => getSessionAdmissionService().markDelivered(ctx.admissionId))
      .catch((error: unknown) => {
        getSessionAdmissionService().markFailed(
          ctx.admissionId,
          error instanceof Error ? error.message : String(error),
        );
        logger.warn('Thread wakeup redelivery failed', {
          instanceId: ctx.instanceId,
          admissionId: ctx.admissionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async reviveTarget(
    automation: Automation,
    destination: ThreadDestination,
  ): ReturnType<RevivalInput['revive']> {
    try {
      return await this.revival.revive({
        instanceId: destination.instanceId,
        historyEntryId: destination.historyEntryId,
        providerSessionId: destination.sessionId,
        workingDirectory: automation.action.workingDirectory,
        reviveIfArchived: destination.reviveIfArchived,
        reason: 'thread-wakeup',
      });
    } catch (error) {
      return {
        status: 'failed',
        failureCode: 'resume_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private fail(run: AutomationRun, reason: string): AutomationRun {
    return this.terminalize(run, 'failed', reason);
  }

  private terminalize(
    run: AutomationRun,
    status: 'succeeded' | 'failed',
    error?: string,
    outputSummary?: string,
  ): AutomationRun {
    const terminal = this.store.terminalizeRun(
      run.id,
      status,
      error,
      outputSummary,
      this.now(),
    );
    if (!terminal) {
      throw new Error(`Thread wakeup run ${run.id} could not be terminalized`);
    }
    return terminal;
  }
}
