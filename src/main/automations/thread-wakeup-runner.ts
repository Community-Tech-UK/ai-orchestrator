import type {
  Automation,
  AutomationDestination,
  AutomationRun,
} from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import { getAutomationEvents } from './automation-events';
import { automatedResendInput } from '../instance/internal-input-provenance';
import { getLogger } from '../logging/logger';
import type { SessionRevivalService } from '../session/session-revival-service';
import type { AutomationStore } from './automation-store';
import { getSessionAdmissionService, type RedeliveryContext, type SuppressReason } from '../session/session-admission-service';
import { isBusyConversationSendError } from './automation-run-failure-class';

import { GlobalPauseService } from '../global-pause/global-pause-service';
import type { AutomaticStartup } from '../work-admission/automatic-startup';

const logger = getLogger('ThreadWakeupRunner');

type ThreadDestination = Extract<AutomationDestination, { kind: 'thread' }>;
type InstanceInput = Pick<InstanceManager, 'sendInput' | 'getInstance' | 'interruptInstance' | 'waitForInstanceSettled'>;

type RevivalInput = Pick<SessionRevivalService, 'revive'>;
type WakeupStore = Pick<AutomationStore, 'attachInstance' | 'terminalizeRun' | 'markThreadPromptDelivered' | 'markThreadPromptAttempt'>;

/** Lifecycle statuses that mean the conversation is working again right now. */
const WORKING_STATUSES = new Set<string>(['busy', 'processing', 'thinking_deeply']);

const RESUME_ALREADY_WORKING = 'That conversation was already working again, so no resume was needed.';
const DEFERRED_BUSY = 'That conversation was busy. Harness will send this when its current turn ends.';
const SKIPPED_BUSY = 'That conversation was busy, so nothing was sent. The next scheduled run will try again.';

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
    // The AutomationRun itself is already terminalized `skipped` by the time
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

    // A15 / 8a: a provider-limit resume whose conversation is already working
    // again needs no resume at all. Checked live before admission so no
    // redelivery is queued for a turn that is already producing output.
    const isResume = Boolean(run.configSnapshot?.action.systemAction ?? automation.action.systemAction);
    if (isResume && this.isConversationWorking(instanceId)) {
      this.recordAttempt(run.id, instanceId, true);
      return this.terminalize(run, 'succeeded', undefined, RESUME_ALREADY_WORKING);
    }

    // A5: re-check live instance state before firing into it — a revived
    // thread can still be waiting_for_permission/interrupting/quota-parked.
    // A15 / 8a: ordinary wake-ups wait for the ready edge (`requireReadyForInput`)
    // and coalesce behind one pending redelivery per automation, so a busy
    // conversation is deferred instead of failed and cannot double-deliver.
    const admission = getSessionAdmissionService().admitAutomatedWrite({
      instanceId,
      origin: 'automation',
      message: automation.action.prompt,
      attachments: automation.action.attachments,
      sourceMetadata: { automationId: automation.id, runId: run.id },
      ...(isResume ? {} : {
        requireReadyForInput: true,
        coalesceKey: `automation:${automation.id}`,
      }),
    });
    if (admission.kind === 'suppressed') {
      return this.endSuppressed(run, automation, instanceId, admission.reason, admission.admissionId);
    }

    try {
      // A provider-limit resume automation can carry a Harness-authored turn;
      // user-written automation prompts pass through unchanged (LT-657).
      const delivery = automatedResendInput(automation.action.prompt);
      let dispatched = false;
      let delivered = false;
      const beforeProviderDispatch = (): void => {
        request.startup?.signal.throwIfAborted();
        dispatched = true;
        sending = true;
        request.onProviderDispatch?.(instanceId);
      };
      await this.instanceManager.sendInput(
        instanceId,
        delivery.message,
        automation.action.attachments,
        {
          ...delivery.options,
          ...(request.startup ? { signal: request.startup.signal } : {}),
          beforeProviderDispatch,
          onProviderInputDelivered: () => { delivered = true; },
        },
      );
      if (dispatched && delivered) this.recordDelivery(run.id, instanceId);
      else this.recordAttempt(run.id, instanceId, !dispatched);
      getSessionAdmissionService().markDelivered(admission.admissionId);
      const summary = `Wakeup prompt delivered to thread ${instanceId}.`;
      return this.terminalize(run, 'succeeded', undefined, summary);
    } catch (error) {
      if (request.startup?.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      getSessionAdmissionService().markFailed(admission.admissionId, message);
      if (isBusyConversationSendError(message)) {
        this.recordAttempt(run.id, instanceId, true);
        if (isResume) {
          return this.terminalize(run, 'succeeded', undefined, RESUME_ALREADY_WORKING);
        }
        // A sendInput race against a turn that started after admission: nothing
        // was written, so end quietly and let the next scheduled run try again.
        logger.warn('Thread wakeup hit a busy conversation on send', {
          automationId: automation.id,
          runId: run.id,
          instanceId,
          error: message,
        });
        return this.terminalize(run, 'skipped', SKIPPED_BUSY);
      }
      const reason = `Thread wakeup send failed: ${message}`;
      logger.warn('Thread wakeup send failed', {
        automationId: automation.id,
        runId: run.id,
        instanceId,
        error: message,
      });
      return this.fail(run, reason);
    }
  }

  /** A15 / 8a: a suppression ends the run once, never as a retryable failure. */
  private endSuppressed(
    run: AutomationRun,
    automation: Automation,
    instanceId: string,
    reason: SuppressReason,
    admissionId: string,
  ): AutomationRun {
    this.recordAttempt(run.id, instanceId, true);
    if (reason === 'terminal' || reason === 'unknown-instance') {
      // The target is gone — retrying a missing target can never succeed.
      getSessionAdmissionService().markFailed(admissionId, reason);
      logger.warn('Thread wakeup target is gone', {
        automationId: automation.id,
        runId: run.id,
        instanceId,
        reason,
        admissionId,
      });
      return this.fail(run, `Thread wakeup failed: target_missing (${reason})`);
    }
    logger.warn('Thread wakeup send suppressed pending instance readiness', {
      automationId: automation.id,
      runId: run.id,
      instanceId,
      reason,
      admissionId,
    });
    return this.terminalize(run, 'skipped', DEFERRED_BUSY);
  }

  private isConversationWorking(instanceId: string): boolean {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) {
      return false;
    }
    return Boolean(instance.activeTurnId) || WORKING_STATUSES.has(instance.status);
  }

  private handleRedelivery(ctx: RedeliveryContext): void {
    const delivery = automatedResendInput(ctx.message);
    const runId = ctx.sourceMetadata?.['runId'];
    if (typeof runId === 'string') this.recordAttempt(runId, ctx.instanceId, false, true);
    let dispatched = false;
    let delivered = false;
    void this.instanceManager
      .sendInput(ctx.instanceId, delivery.message, ctx.attachments, {
        ...delivery.options, beforeProviderDispatch: () => { dispatched = true; }, onProviderInputDelivered: () => { delivered = true; },
      })
      .then(() => {
        if (typeof runId === 'string') {
          if (dispatched && delivered) this.recordDelivery(runId, ctx.instanceId, true);
          else this.recordAttempt(runId, ctx.instanceId, !dispatched, true);
        }
        getSessionAdmissionService().markDelivered(ctx.admissionId);
      })
      .catch((error: unknown) => {
        if (typeof runId === 'string' && isBusyConversationSendError(error instanceof Error ? error.message : String(error))) {
          this.recordAttempt(runId, ctx.instanceId, true, true);
        }
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

  private recordAttempt(runId: string, instanceId: string, notDelivered = false, publish = false): void {
    try {
      const run = this.store.markThreadPromptAttempt(runId, instanceId, notDelivered, this.now());
      if (publish && run) getAutomationEvents().emitRunChanged({ automationId: run.automationId, run, updateKind: 'delivery-evidence' });
    } catch (error) {
      logger.warn('Could not record thread prompt attempt', { runId, instanceId, error });
    }
  }

  private recordDelivery(runId: string, instanceId: string, publish = false): void {
    try {
      const run = this.store.markThreadPromptDelivered(runId, instanceId, this.now());
      if (publish && run) getAutomationEvents().emitRunChanged({ automationId: run.automationId, run, updateKind: 'delivery-evidence' });
    } catch (error) {
      // A delivered prompt must never become a send failure/retry because evidence could not be saved.
      logger.warn('Could not record thread prompt delivery', { runId, instanceId, error });
    }
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
    status: 'succeeded' | 'failed' | 'skipped',
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
