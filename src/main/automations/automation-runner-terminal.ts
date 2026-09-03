/**
 * Terminal-run bookkeeping for AutomationRunner.
 *
 * Extracted from `automation-runner.ts` so the runner stays inside its LOC
 * ceiling. Callers pass the live runner host; this module does not own
 * runner state. Behaviour matches the previous private method.
 */

import { getLogger } from '../logging/logger';
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
} from '../../shared/types/automation.types';
import { emitPluginHook } from '../plugins/hook-emitter';
import { computeRetryDelayMs } from './automation-retry';
import { deliverRunSummaryToChannel } from './automation-runner-helpers';
import type { RetrySchedulerCallback } from './automation-runner-types';

const logger = getLogger('AutomationRunner');

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
  const retryable = options?.retryable ?? true;
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

  if (host.isOneTimeRun(run)) {
    host.emitAutomationState(run.automationId);
    const hasRetryPending =
      run.status === 'failed' &&
      retryable &&
      (run.attempt ?? 1) < (run.maxAttempts ?? 1) &&
      host.retryScheduler !== null;
    if (!hasRetryPending) {
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
  deliverRunSummaryToChannel(run).catch((deliveryError) => {
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
