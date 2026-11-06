/**
 * One fault must not set aside a whole run. Three matching failures in a short time put the run on hold: nothing new
 * starts, but work in progress carries on, which is why this is not Pause. Harness then tries a single job after 10,
 * 30 and 60 minutes, then hourly, and gives up after six hours. Any success or Resume clears the hold.
 */
import { getLogger } from '../logging/logger';
import { normaliseFailure } from './plan-queue-failure-class';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueRunBreaker');

const FAILURES_TO_HOLD = 3;
const FAILURE_WINDOW_MS = 15 * 60_000;
const TRIAL_GAPS_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000];
const GIVE_UP_AFTER_MS = 6 * 60 * 60_000;

/** `itemId` is null for triage, which fails for a whole batch, not one job. */
interface Failure { key: string; itemId: string | null; at: number }
/** `tried` stays false until the first trial starts, so nothing can pass for a trial before then. */
interface Trials { heldAt: number; nextAt: number; tries: number; tried: boolean; itemId: string | null; gaveUp: boolean }

type BreakerHost = Pick<PlanQueueFlowHost, 'getRun' | 'setRunHold' | 'requestPump'>;

const LAST_ERROR = 'Last error: ';
const MAX_STORED_ERROR = 500;
const GAVE_UP = 'Harness has stopped trying, so fix the fault and press Resume.';

export class PlanQueueRunBreaker {
  private readonly failures = new Map<string, Failure[]>();
  private readonly trials = new Map<string, Trials>();

  constructor(private readonly host: BreakerHost, private readonly now: () => number = Date.now) {}

  /** One failure that isn't plainly the job's fault. The third matching one, across jobs, holds the run. */
  note(runId: string, itemId: string | null, message: string): void {
    const now = this.now();
    const key = normaliseFailure(message);
    const recent = [...(this.failures.get(runId) ?? []).filter(failure => now - failure.at < FAILURE_WINDOW_MS), { key, itemId, at: now }];
    this.failures.set(runId, recent);
    const matching = recent.filter(failure => failure.key === key);
    const acrossJobs = new Set(matching.map(failure => failure.itemId)).size > 1 || matching.some(failure => failure.itemId === null);
    if (matching.length < FAILURES_TO_HOLD || !acrossJobs) return;
    this.failures.delete(runId);
    const run = this.host.getRun(runId);
    if (run.status !== 'running' || run.holdReason) return;
    logger.warn('Plan queue: holding a run after a shared failure', { runId, key });
    this.trials.set(runId, this.freshTrials(run, now));
    this.host.setRunHold(runId, `No new work is starting, because three jobs failed the same way. Work in progress carries on, and Harness will try one job again shortly. ${LAST_ERROR}${message.slice(0, MAX_STORED_ERROR)}`);
  }

  /**
   * Only the trial proves the fault has passed. Other work going through proves nothing: during an outage a live
   * worker can still respawn, and that must neither lift the hold nor reset the count of failures.
   */
  succeeded(runId: string, itemId: string | null): void {
    if (!this.isTrial(runId, itemId)) return;
    this.trials.delete(runId);
    this.failures.delete(runId);
    this.host.setRunHold(runId, null);
    this.host.requestPump();
  }

  /** Whether the run may start something now. On hold, only when a trial is due. */
  canStart(run: PlanQueueRun): boolean {
    if (!run.holdReason) return true;
    const now = this.now();
    const trials = this.trials.get(run.id) ?? this.freshTrials(run, now);
    this.trials.set(run.id, trials);
    if (trials.gaveUp || now < trials.nextAt) return false;
    if (now - trials.heldAt < GIVE_UP_AFTER_MS) return true;
    trials.gaveUp = true;
    this.host.setRunHold(run.id, `No new work is starting, because three jobs failed the same way. ${GAVE_UP} ${LAST_ERROR}${holdError(run)}`);
    return false;
  }

  /** Call for each start. On hold that start is the trial, so the next one waits for the next gap. */
  started(run: PlanQueueRun, itemId: string | null): void {
    if (!run.holdReason) return;
    const trials = this.trials.get(run.id);
    if (!trials) return;
    trials.itemId = itemId;
    trials.tried = true;
    trials.nextAt = this.now() + (TRIAL_GAPS_MS[trials.tries + 1] ?? TRIAL_GAPS_MS.at(-1)!);
    trials.tries += 1;
  }

  /** The trial hit the fault the run is held for, so it goes back in line. Any other failure is the job's own. */
  isTrialOfSameFault(runId: string, itemId: string, message: string): boolean {
    return this.isTrial(runId, itemId) && normaliseFailure(message.slice(0, MAX_STORED_ERROR)) === normaliseFailure(holdError(this.host.getRun(runId)));
  }

  private isTrial(runId: string, itemId: string | null): boolean {
    const trials = this.trials.get(runId);
    return trials?.tried === true && trials.itemId === itemId;
  }

  private freshTrials(run: PlanQueueRun, now: number): Trials {
    return { heldAt: now, nextAt: now + TRIAL_GAPS_MS[0], tries: 0, tried: false, itemId: null, gaveUp: run.holdReason?.includes(GAVE_UP) ?? false };
  }
}

function holdError(run: PlanQueueRun): string {
  return run.holdReason?.split(LAST_ERROR).at(-1) ?? '';
}
