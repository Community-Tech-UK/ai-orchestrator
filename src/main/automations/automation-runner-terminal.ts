/**
 * Terminal-run bookkeeping for AutomationRunner.
 *
 * Extracted from `automation-runner.ts` so the runner stays inside its LOC
 * ceiling. Callers pass the live runner host; this module does not own
 * runner state. Behaviour matches the previous private method.
 */

import { getLogger } from '../logging/logger';
import { getNotificationService } from '../notifications/notification-service';
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
} from '../../shared/types/automation.types';
import { emitPluginHook } from '../plugins/hook-emitter';
import { computeRetryDelayMs } from './automation-retry';
import { isProviderLimitRunError } from './automation-run-provider-limit';
import { classifyAutomationRunFailure } from './automation-run-failure-class';
import { getAutomationCheckStore } from './automation-check-store';
import { deliverRunSummaryToChannel } from './automation-runner-helpers';
import type { RetrySchedulerCallback } from './automation-runner-types';

const logger = getLogger('AutomationRunner');

/** Best-effort breaker notice; notification failure never changes run bookkeeping. */
export function notifyAutomationDisabled(automationId: string, consecutiveFailures?: number, reason?: string): void {
  try {
    getNotificationService().notify({
      kind: 'automation-breaker',
      title: 'Automation auto-disabled',
      body: `Disabled after ${consecutiveFailures ?? 'repeated'} consecutive failures`
        + `${reason ? ` (last: ${reason.slice(0, 200)})` : ''}. Re-enable it from the Automations page.`,
      urgency: 'critical',
      fingerprintFields: { automationId },
    });
  } catch {
    // Notification failure must never affect run bookkeeping.
  }
}

export interface AutomationTerminalRunHost {
  events: {
    emitRunChanged(event: { automationId: string; run: AutomationRun }): void;
    emitRunTerminal(event: {
      automationId: string;
      runId: string;
      status: Exclude<AutomationRunStatus, 'pending' | 'running'>;
    }): void;
    emitScheduleDeactivated(event: { automationId: string }): void;
    emitChanged(event: {
      automation: Automation | null;
      automationId: string;
      type: 'created' | 'updated' | 'deleted';
    }): void;
  };
  store: {
    markDeliveryStarted(runId: string, now: number): boolean;
    recordRunOutcome(
      automationId: string,
      status: AutomationRunStatus,
      reason: string | undefined,
      now?: number,
    ): { automation: Automation | null; autoDisabled: boolean };
    delete(id: string): Promise<{ runningInstanceIds: string[] }>;
  };
  retryScheduler: RetrySchedulerCallback | null;
  now(): number;
  isOneTimeRun(run: AutomationRun): boolean;
  notifyAutoDisabled(automationId: string, consecutiveFailures?: number, reason?: string): void;
  emitAutomationState(automationId: string): void;
  untrackInstances(instanceIds: string[]): void;
  promotePendingIfAny(automationId?: string): Promise<void>;
  baseRetryDelayMs: number;
}

export function handleTerminalRun(
  host: AutomationTerminalRunHost,
  run: AutomationRun,
  options?: { retryable?: boolean },
): void {
  // A provider-limit failure is never auto-retried: a retry would hit the same limit, and
  // could duplicate an opt-in park-resume. The next scheduled fire is the recovery.
  const retryable = (options?.retryable ?? true)
    && !isProviderLimitRunError(run.error)
    && classifyAutomationRunFailure(run.error) !== 'never';
  const willRetry = run.status === 'failed'
    && retryable
    && (run.attempt ?? 1) < (run.maxAttempts ?? 1)
    && host.retryScheduler !== null;
  host.events.emitRunChanged({ automationId: run.automationId, run });
  host.events.emitRunTerminal({
    automationId: run.automationId,
    runId: run.id,
    status: run.status as Exclude<AutomationRunStatus, 'pending' | 'running'>,
  });
  if (run.status === 'failed') {
    emitPluginHook('automation.run.failed', {
      automationId: run.automationId,
      runId: run.id,
      status: run.status,
      error: run.error ?? undefined,
      outputFullRef: run.outputFullRef ?? undefined,
      timestamp: Date.now(),
    });
  } else {
    emitPluginHook('automation.run.completed', {
      automationId: run.automationId,
      runId: run.id,
      status: run.status,
      outputSummary: run.outputSummary ?? undefined,
      outputFullRef: run.outputFullRef ?? undefined,
      timestamp: Date.now(),
    });
  }

  if (run.status === 'failed') {
    const attempt = run.attempt ?? 1;
    const maxAttempts = run.maxAttempts ?? 1;
    if (retryable && attempt < maxAttempts && host.retryScheduler) {
      const delayMs = computeRetryDelayMs(run.automationId, attempt, host.baseRetryDelayMs);
      logger.info('Scheduling automation retry', {
        automationId: run.automationId,
        runId: run.id,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
      });
      host.retryScheduler(run, attempt + 1, maxAttempts, delayMs);
    } else {
      const outcome = host.store.recordRunOutcome(
        run.automationId,
        run.status,
        run.error ?? undefined,
        host.now(),
      );
      if (outcome.autoDisabled) {
        logger.warn('Automation auto-disabled after repeated failures', {
          automationId: run.automationId,
          consecutiveFailures: outcome.automation?.consecutiveFailures,
          lastFailureReason: run.error ?? undefined,
        });
        host.notifyAutoDisabled(run.automationId, outcome.automation?.consecutiveFailures, run.error ?? undefined);
        host.emitAutomationState(run.automationId);
        host.events.emitScheduleDeactivated({ automationId: run.automationId });
      }
    }
  } else if (run.status === 'succeeded') {
    const outcome = host.store.recordRunOutcome(
      run.automationId,
      run.status,
      undefined,
      host.now(),
    );
    if (outcome.autoDisabled) {
      host.emitAutomationState(run.automationId);
      host.events.emitScheduleDeactivated({ automationId: run.automationId });
    }
  }

  if (run.configSnapshot?.action.preCheck) {
    const checkStore = getAutomationCheckStore();
    // A handled thread wakeup can succeed without dispatching its prompt.
    // Only explicit no-delivery evidence excludes that check from the baseline;
    // legacy/unknown receipts and system actions retain their existing semantics.
    const threadPromptNotDelivered = run.configSnapshot.destination.kind === 'thread'
      && !run.configSnapshot.action.systemAction
      && run.threadPromptDelivered === false;
    if (run.status === 'succeeded' && !threadPromptNotDelivered) {
      checkStore.promotePending(run.id);
    } else if (!willRetry) {
      checkStore.clearPending(run.id);
    }
  }

  if (run.status === 'succeeded') host.emitAutomationState(run.automationId);
  if (host.isOneTimeRun(run)) {
    host.emitAutomationState(run.automationId);
    if (!willRetry) {
      host.events.emitScheduleDeactivated({ automationId: run.automationId });
    }
  }
  const systemActionType = run.configSnapshot?.action.systemAction?.type;
  if (
    run.status === 'succeeded'
    && host.isOneTimeRun(run)
    && (systemActionType === 'instanceProviderLimitResume' || systemActionType === 'loopProviderLimitResume')
  ) {
    host.store.delete(run.automationId)
      .then(({ runningInstanceIds }) => {
        host.untrackInstances(runningInstanceIds);
        host.events.emitChanged({ automation: null, automationId: run.automationId, type: 'deleted' });
      })
      .catch((deleteError) => {
        logger.warn('Failed to delete fired provider-limit resume automation', {
          automationId: run.automationId,
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
        });
      });
  }
  deliverRunSummaryToChannel(run, () => host.store.markDeliveryStarted(run.id, host.now())).catch((deliveryError) => {
    logger.warn('Failed to deliver automation run summary to channel', {
      automationId: run.automationId,
      runId: run.id,
      error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
    });
  });
  host.promotePendingIfAny(run.automationId).catch((promoteError) => {
    logger.warn('Failed to promote pending automation run', {
      automationId: run.automationId,
      error: promoteError instanceof Error ? promoteError.message : String(promoteError),
    });
  });
}
