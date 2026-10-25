import type {
  Automation,
  AutomationDestination,
  AutomationRun,
} from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import { automatedResendInput } from '../instance/internal-input-provenance';
import { getLogger } from '../logging/logger';
import type { SessionRevivalService } from '../session/session-revival-service';
import type { AutomationStore } from './automation-store';
import { getSessionAdmissionService, type RedeliveryContext } from '../session/session-admission-service';

import { GlobalPauseService } from '../global-pause/global-pause-service';
import type { AutomaticStartup } from '../work-admission/automatic-startup';

const logger = getLogger('ThreadWakeupRunner');

type ThreadDestination = Extract<AutomationDestination, { kind: 'thread' }>;
type InstanceInput = Pick<InstanceManager, 'sendInput' | 'getInstance' | 'interruptInstance' | 'waitForInstanceSettled'>;
type RevivalInput = Pick<SessionRevivalService, 'revive'>;
type WakeupStore = Pick<AutomationStore, 'attachInstance' | 'terminalizeRun'>;

export interface ThreadWakeupRequest {
  run: AutomationRun;
  automation: Automation;
  destination: ThreadDestination;
  startup?: AutomaticStartup;
  onProviderDispatch?: (instanceId: string) => void;
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
      request.startup?.signal.throwIfAborted();
      const reason = `Thread wakeup failed: ${revived.failureCode ?? 'target_missing'}${revived.error ? ` (${revived.error})` : ''}`;
      return this.fail(run, reason);
    }

    const instanceId = revived.instanceId;
    let sending = false;
    request.startup?.register({ id: instanceId }, async () => {
      if (!sending || (GlobalPauseService.peek() && !GlobalPauseService.peek()?.holdsAutomaticInput(instanceId))) return;
      const live = this.instanceManager.getInstance(instanceId);
      if (live && ['initializing', 'busy', 'processing', 'thinking_deeply', 'interrupting', 'respawning'].includes(live.status)) {
        const pause = GlobalPauseService.peek();
        const controller = new AbortController();
        const pickedUp = (): void => { if (pause && !pause.holdsAutomaticInput(instanceId)) controller.abort(); };
        pause?.on('state-changed', pickedUp);
        try {
          pickedUp();
          if (controller.signal.aborted) return;
          this.instanceManager.interruptInstance(instanceId, 'pause');
          await this.instanceManager.waitForInstanceSettled(instanceId, { timeoutMs: 31_000, signal: controller.signal });
        } catch (error) { if (!controller.signal.aborted) throw error; }
        finally { pause?.off('state-changed', pickedUp); }
      }
    });
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
      // A provider-limit resume automation can carry a Harness-authored turn;
      // user-written automation prompts pass through unchanged (LT-657).
      const delivery = automatedResendInput(automation.action.prompt);
      const beforeProviderDispatch = (): void => {
        request.startup?.signal.throwIfAborted();
        sending = true;
        request.onProviderDispatch?.(instanceId);
      };
      await this.instanceManager.sendInput(
        instanceId,
        delivery.message,
        automation.action.attachments,
        request.startup ? { ...delivery.options, signal: request.startup.signal, beforeProviderDispatch } : delivery.options,
      );
      getSessionAdmissionService().markDelivered(admission.admissionId);
      const summary = `Wakeup prompt delivered to thread ${instanceId}.`;
      return this.terminalize(run, 'succeeded', undefined, summary);
    } catch (error) {
      if (request.startup?.signal.aborted) throw error;
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
    const delivery = automatedResendInput(ctx.message);
    void this.instanceManager
      .sendInput(ctx.instanceId, delivery.message, ctx.attachments, delivery.options)
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
