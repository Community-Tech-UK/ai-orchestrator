import { powerMonitor } from 'electron';
import { getLogger } from '../logging/logger';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { computeNextFireAt } from './automation-schedule';
import { getAutomationEvents } from './automation-events';
import type { Automation, AutomationRun } from '../../shared/types/automation.types';

const logger = getLogger('AutomationScheduler');
const MAX_TIMEOUT_MS = 2_147_000_000;

interface ScheduledHandle {
  timeout: NodeJS.Timeout;
  targetAt: number;
}

interface RetryHandle {
  timeout: NodeJS.Timeout;
  automationId: string;
  nextAttempt: number;
  maxAttempts: number;
  originalRunId: string;
}

export class AutomationScheduler {
  private readonly handles = new Map<string, ScheduledHandle>();
  /**
   * Retry timers keyed by the ORIGINAL failed run ID (not the automation ID)
   * so a single automation can have at most one pending retry per failed run.
   */
  private readonly retryHandles = new Map<string, RetryHandle>();
  private initialized = false;
  private suspendedAt: number | null = null;

  constructor(
    private readonly store: AutomationStore,
    private readonly runner: AutomationRunner,
    private readonly catchUp: CatchUpCoordinator,
    private readonly events = getAutomationEvents(),
    private readonly now = () => Date.now(),
  ) {
    // Register this scheduler as the retry callback so the runner can schedule
    // retries without holding a direct reference back to the scheduler.
    this.runner.setRetryScheduler(
      (originalRun, nextAttempt, maxAttempts, delayMs) => {
        this.scheduleRetry(originalRun, nextAttempt, maxAttempts, delayMs);
      },
    );
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    for (const automation of this.store.listSchedulable()) {
      this.schedule(automation);
    }

    // BUG 2: Re-arm durable pending retries that survived a restart.
    // failRunningRuns (called by AutomationRunner.initialize) only touches
    // 'running' rows, so 'failed' rows with next_retry_at are untouched.
    const pendingRetries = this.store.listPendingRetries();
    for (const pending of pendingRetries) {
      const delay = Math.max(0, pending.nextRetryAt - this.now());
      const originalRun = this.store.getRun(pending.runId);
      if (!originalRun) {
        // Run was deleted — clear the marker so it doesn't reappear.
        this.store.clearPendingRetry(pending.runId);
        continue;
      }
      const timeout = setTimeout(() => {
        void this.onRetryTimer(originalRun, pending.nextRetryAttempt, pending.nextRetryMaxAttempts);
      }, Math.min(delay, MAX_TIMEOUT_MS));
      timeout.unref?.();
      this.retryHandles.set(pending.runId, {
        timeout,
        automationId: pending.automationId,
        nextAttempt: pending.nextRetryAttempt,
        maxAttempts: pending.nextRetryMaxAttempts,
        originalRunId: pending.runId,
      });
      logger.info('Re-armed durable retry timer after restart', {
        automationId: pending.automationId,
        originalRunId: pending.runId,
        nextAttempt: pending.nextRetryAttempt,
        delayMs: delay,
      });
    }

    this.events.on('automation:changed', (event: { automation: Automation | null; automationId: string }) => {
      if (event.automation?.active && event.automation.enabled && event.automation.nextFireAt !== null) {
        this.schedule(event.automation);
      } else {
        this.deactivate(event.automationId);
      }
    });
    this.events.on('automation:schedule-deactivated', (event: { automationId: string }) => {
      this.deactivate(event.automationId);
    });
    this.events.on('automation:orphaned-fire', (event: { automationId: string }) => {
      this.deactivate(event.automationId);
    });
    this.events.on('automation:run-terminal', (event: { automationId: string; runId: string }) => {
      const run = this.store.getRun(event.runId);
      if (run?.configSnapshot?.schedule.type === 'oneTime') {
        // BUG 1 FIX: use deactivateSchedule (clears only the fire handle) so that
        // any retry timer just scheduled for a failed oneTime run is NOT cancelled.
        this.deactivateSchedule(event.automationId);
      }
    });

    powerMonitor.on('suspend', () => {
      this.suspendedAt = this.now();
    });
    powerMonitor.on('resume', () => {
      const resumedAt = this.now();
      const suspendedAt = this.suspendedAt;
      this.suspendedAt = null;
      this.catchUp.runResumeSweep({ suspendedAt, resumedAt }).catch((error) => {
        logger.warn('Automation resume sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.rescheduleAll();
    });
  }

  schedule(automation: Automation): void {
    // Only clear the fire handle, not retry timers — scheduling a new fire
    // time does not cancel retries for a failed previous run.
    this.deactivateSchedule(automation.id);
    if (!automation.active || !automation.enabled || automation.nextFireAt === null) {
      return;
    }

    const delay = Math.max(0, automation.nextFireAt - this.now());
    const timeout = setTimeout(() => {
      void this.onTimer(automation.id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    timeout.unref?.();
    this.handles.set(automation.id, { timeout, targetAt: automation.nextFireAt });
  }

  /**
   * BUG 1 FIX: Clear ONLY the scheduled-fire handle for an automation, leaving
   * any pending retry timers intact.  Use this when a oneTime automation
   * completes (success or failure) so that a retry that was just scheduled for
   * a failed run is not immediately cancelled.
   */
  deactivateSchedule(automationId: string): void {
    const handle = this.handles.get(automationId);
    if (handle) {
      clearTimeout(handle.timeout);
      this.handles.delete(automationId);
    }
  }

  /**
   * Full deactivation: cancel the scheduled-fire handle AND all retry timers
   * for this automation.  Use for genuine teardown: automation deleted/disabled,
   * schedule-deactivated, or orphaned-fire events.
   */
  deactivate(automationId: string): void {
    this.deactivateSchedule(automationId);
    // Also cancel any pending retry timers for this automation.
    const retryRunIds = [...this.retryHandles.entries()]
      .filter(([, h]) => h.automationId === automationId)
      .map(([runId]) => runId);
    for (const runId of retryRunIds) {
      const retryHandle = this.retryHandles.get(runId);
      if (retryHandle) {
        clearTimeout(retryHandle.timeout);
        this.retryHandles.delete(runId);
        // BUG 4 FIX: clear persisted pending-retry so it won't be re-armed on
        // the next restart.
        this.store.clearPendingRetry(runId);
      }
    }
  }

  /**
   * Cancel all pending retry timers associated with a specific original run
   * (e.g. when the automation is deleted or when a newer retry supersedes this
   * one). Safe to call even if no timer exists.
   */
  cancelRetry(originalRunId: string): void {
    const handle = this.retryHandles.get(originalRunId);
    if (handle) {
      clearTimeout(handle.timeout);
      this.retryHandles.delete(originalRunId);
      // BUG 4 FIX: clear persisted pending-retry fields so the timer won't be
      // re-armed on the next restart.
      this.store.clearPendingRetry(originalRunId);
    }
  }

  /**
   * Schedule a retry for a failed run.  Called by the runner via the
   * RetrySchedulerCallback registered in the constructor.
   *
   * The scheduler is the sole owner of the timer. When the timer fires,
   * it creates the new run record and hands it to the runner.
   *
   * BUG 2 FIX: persists the pending-retry fields so the timer survives restart.
   * BUG 4 FIX: cancels any existing retry for the same run before arming a new
   *            one, preventing double-fire.
   */
  scheduleRetry(
    originalRun: AutomationRun,
    nextAttempt: number,
    maxAttempts: number,
    delayMs: number,
  ): void {
    // Cancel any existing retry for this run (shouldn't normally happen but
    // guards against double-scheduling).  cancelRetry also clears persistence.
    this.cancelRetry(originalRun.id);

    const nextRetryAt = this.now() + Math.min(delayMs, MAX_TIMEOUT_MS);
    // BUG 2: persist so the timer can be re-armed after restart.
    this.store.markPendingRetry(originalRun.id, nextRetryAt, nextAttempt, maxAttempts);

    const timeout = setTimeout(() => {
      void this.onRetryTimer(originalRun, nextAttempt, maxAttempts);
    }, Math.min(delayMs, MAX_TIMEOUT_MS));
    timeout.unref?.();

    this.retryHandles.set(originalRun.id, {
      timeout,
      automationId: originalRun.automationId,
      nextAttempt,
      maxAttempts,
      originalRunId: originalRun.id,
    });
  }

  private async onRetryTimer(
    originalRun: AutomationRun,
    nextAttempt: number,
    maxAttempts: number,
  ): Promise<void> {
    this.retryHandles.delete(originalRun.id);

    // BUG 2 FIX: clear the persisted pending-retry fields now that the timer
    // has fired.  We do this before inserting the new run so that even if
    // insertRetryRun throws the durability marker is cleared.
    this.store.clearPendingRetry(originalRun.id);

    const retryAt = this.now();

    // BUG 3 FIX: respect the automation's concurrencyPolicy before dispatching.
    //
    // Policy resolution (derived from the original run's config snapshot to
    // avoid an async store.get() that would complicate fake-timer tests):
    //   skip  — if a run is currently active (running or pending), skip this
    //            retry entirely.  If this was the last attempt, record the
    //            give-up so the consecutive-failure streak is updated.
    //   queue — insert as 'pending' so the existing claimNextPending promotion
    //            path runs it without overlap (no duplicate active runs).
    //   (no active run) — fall through and dispatch immediately in both cases.
    //
    // Streak accounting note: skipping a retry because of a concurrency
    // collision does NOT count as a failure for streak purposes (the automation
    // is actively running — this is not an error condition).  However if the
    // collision means we are giving up on the last attempt, we record the
    // original failure outcome so the streak increments correctly.
    //
    // concurrencyPolicy is read from the original run's configSnapshot so we
    // do not need an async lookup and the code works even if the automation row
    // was updated in the interim (snapshot-based isolation is consistent with
    // the rest of the retry path).
    const concurrencyPolicy = originalRun.configSnapshot?.concurrencyPolicy ?? 'skip';

    // Check whether a run is already active for this automation.
    const activeRuns = this.store.listRuns({ automationId: originalRun.automationId, limit: 10 });
    const hasActiveRun = activeRuns.some((r) => r.status === 'running' || r.status === 'pending');

    if (hasActiveRun && concurrencyPolicy === 'skip') {
      logger.info('Automation retry skipped — concurrencyPolicy=skip and a run is active', {
        automationId: originalRun.automationId,
        originalRunId: originalRun.id,
        nextAttempt,
        maxAttempts,
      });
      // If this was the last attempt, record the give-up so the failure streak
      // advances.  We use the original run's error as the reason.
      if (nextAttempt >= maxAttempts) {
        this.runner.recordGiveUpOutcome(originalRun);
      }
      return;
    }

    if (hasActiveRun && concurrencyPolicy === 'queue') {
      // Insert as pending; the existing promotion path will start it.
      const pendingRun = this.store.insertPendingRetryRun(
        originalRun,
        nextAttempt,
        maxAttempts,
        retryAt,
        retryAt,
      );
      if (!pendingRun) {
        logger.warn('Automation retry aborted during queue insert — automation no longer exists', {
          automationId: originalRun.automationId,
          originalRunId: originalRun.id,
          nextAttempt,
        });
        return;
      }
      logger.info('Queued automation retry run (concurrencyPolicy=queue)', {
        automationId: originalRun.automationId,
        originalRunId: originalRun.id,
        pendingRunId: pendingRun.id,
        attempt: nextAttempt,
        maxAttempts,
      });
      return;
    }

    // No active run (or no concurrency concern) — insert as running and dispatch.
    const retryRun = this.store.insertRetryRun(
      originalRun,
      nextAttempt,
      maxAttempts,
      retryAt,
      retryAt,
    );
    if (!retryRun) {
      logger.warn('Automation retry aborted — automation no longer exists', {
        automationId: originalRun.automationId,
        originalRunId: originalRun.id,
        nextAttempt,
      });
      return;
    }

    logger.info('Firing automation retry', {
      automationId: originalRun.automationId,
      originalRunId: originalRun.id,
      retryRunId: retryRun.id,
      attempt: nextAttempt,
      maxAttempts,
    });

    try {
      await this.runner.dispatchRetryRun(retryRun);
    } catch (error) {
      logger.error(
        'Automation retry dispatch threw unexpectedly',
        error instanceof Error ? error : new Error(String(error)),
        { automationId: originalRun.automationId, retryRunId: retryRun.id },
      );
    }
  }

  private async onTimer(automationId: string): Promise<void> {
    const automation = await this.store.get(automationId);
    if (!automation || !automation.active || !automation.enabled || automation.nextFireAt === null) {
      this.deactivate(automationId);
      return;
    }

    const scheduledAt = automation.nextFireAt;
    if (scheduledAt - this.now() > 1000) {
      this.schedule(automation);
      return;
    }

    const nextFireAt = automation.schedule.type === 'cron'
      ? computeNextFireAt(automation.schedule, scheduledAt + 1000)
      : null;
    this.store.setNextFireAt(automation.id, nextFireAt, this.now());

    const updated = await this.store.get(automation.id);
    if (updated) {
      if (nextFireAt !== null) {
        this.schedule(updated);
      } else {
        this.deactivate(automation.id);
      }
      this.events.emitChanged({ automation: updated, automationId: updated.id, type: 'updated' });
    }

    await this.runner.fire(automation.id, { trigger: 'scheduled', scheduledAt });
  }

  private async rescheduleAll(): Promise<void> {
    // Only reschedule the scheduled-fire handles; leave retry timers intact
    // (a power resume should not cancel pending retries).
    // schedule() now calls deactivateSchedule() internally, so this is safe.
    for (const automationId of this.handles.keys()) {
      this.deactivateSchedule(automationId);
    }
    for (const automation of this.store.listSchedulable()) {
      this.schedule(automation);
    }
  }
}
