import type { LocalAiTarget } from '../../shared/types/local-ai-guard.types';
import type {
  LocalAiHealthSchedulerLogger,
  LocalAiSchedulerTimerPort,
} from './local-ai-health-scheduler';
import type { LocalAiTargetRepository } from './local-ai-target-repository';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;

interface PauseExpiryTimer {
  handle: unknown;
  deadline: number;
  token: symbol;
  retryAttempt: number;
}

export class LocalAiPauseExpiryController {
  private readonly timersByTarget = new Map<string, PauseExpiryTimer>();

  constructor(
    private readonly targets: Pick<LocalAiTargetRepository, 'get' | 'setLifecycle'>,
    private readonly timers: LocalAiSchedulerTimerPort,
    private readonly now: () => number,
    private readonly getRevision: (targetId: string) => number,
    private readonly onTransition: (targetId: string) => void,
    private readonly logger: LocalAiHealthSchedulerLogger,
  ) {}

  schedule(target: LocalAiTarget): void {
    const deadline = target.pausedUntil;
    if (target.lifecycle !== 'paused' || deadline === undefined) return;
    this.cancel(target.id);
    const token = Symbol(target.id);
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, Math.round(deadline - this.currentTimestamp())),
    );
    this.scheduleTimer(target.id, deadline, token, delay, 0);
  }

  cancel(targetId: string): void {
    const scheduled = this.timersByTarget.get(targetId);
    if (!scheduled) return;
    this.timers.cancel(scheduled.handle);
    this.timersByTarget.delete(targetId);
  }

  stop(): void {
    for (const scheduled of this.timersByTarget.values()) {
      this.timers.cancel(scheduled.handle);
    }
    this.timersByTarget.clear();
  }

  private expire(
    targetId: string,
    deadline: number,
    token: symbol,
    retryAttempt: number,
  ): void {
    const scheduled = this.timersByTarget.get(targetId);
    if (!scheduled || scheduled.token !== token || scheduled.deadline !== deadline) return;
    this.timersByTarget.delete(targetId);
    const current = this.readTarget(targetId, deadline, retryAttempt);
    if (!current || current.lifecycle !== 'paused' || current.pausedUntil !== deadline) return;
    if (deadline > this.currentTimestamp()) {
      this.schedule(current);
      return;
    }
    const revision = this.getRevision(targetId);
    try {
      this.targets.setLifecycle(targetId, 'enrolled');
    } catch {
      const latest = this.readTarget(targetId, deadline, retryAttempt);
      if (latest?.lifecycle === 'paused' && latest.pausedUntil === deadline) {
        this.scheduleRetry(targetId, deadline, retryAttempt, 'lifecycle-transition-failed');
      }
      return;
    }
    if (revision === this.getRevision(targetId)) this.onTransition(targetId);
  }

  private readTarget(
    targetId: string,
    deadline: number,
    retryAttempt: number,
  ): LocalAiTarget | undefined {
    try {
      return this.targets.get(targetId);
    } catch {
      this.scheduleRetry(targetId, deadline, retryAttempt, 'target-read-failed');
      return undefined;
    }
  }

  private scheduleRetry(
    targetId: string,
    deadline: number,
    retryAttempt: number,
    reason: 'lifecycle-transition-failed' | 'target-read-failed',
  ): void {
    this.logger.warn('Local AI Guard timed pause could not resume', { reason });
    const nextAttempt = Math.min(retryAttempt + 1, 30);
    const retryDelay = Math.min(
      RETRY_MAX_DELAY_MS,
      RETRY_BASE_DELAY_MS * (2 ** Math.min(retryAttempt, 16)),
    );
    this.scheduleTimer(targetId, deadline, Symbol(targetId), retryDelay, nextAttempt);
  }

  private currentTimestamp(): number {
    const now = this.now();
    return Number.isSafeInteger(now) && now >= 0 ? now : 0;
  }

  private scheduleTimer(
    targetId: string,
    deadline: number,
    token: symbol,
    delay: number,
    retryAttempt: number,
  ): void {
    const handle = this.timers.schedule(
      () => this.expire(targetId, deadline, token, retryAttempt),
      delay,
    );
    this.timersByTarget.set(targetId, { handle, deadline, token, retryAttempt });
  }
}
