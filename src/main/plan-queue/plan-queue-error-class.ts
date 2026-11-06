/** Queue-specific backoff for failures that pass by themselves. */
import { classifyQueuePreparationError } from './plan-queue-failure-class';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueRunBreaker } from './plan-queue-run-breaker';
import type { PlanQueueItem } from './plan-queue.types';

export class PlanQueuePreparationErrors {
  private readonly waitingUntil = new Map<string, number>();
  constructor(private readonly host: PlanQueueFlowHost, private readonly breaker: PlanQueueRunBreaker) {}

  succeeded(runId: string, itemId: string): void { this.breaker.succeeded(runId, itemId); this.waitingUntil.set(itemId, 0); }

  /** Keeps a job from being picked up again for a while, so a passing fault can pass. */
  holdOff(itemId: string, ms: number): void { this.waitingUntil.set(itemId, Date.now() + ms); }
  forget(itemId: string): void { this.waitingUntil.delete(itemId); }

  waiting(item: PlanQueueItem): boolean {
    if (!this.waitingUntil.has(item.id)) {
      const events = this.host.history.listEvents(item.id);
      const waiting = events.findIndex(row => row.reason === 'capacity-wait');
      const working = events.findIndex(row => row.toState === 'working');
      this.waitingUntil.set(item.id, waiting >= 0 && (working < 0 || waiting < working) ? Number(events[waiting].detailHead) : 0);
    }
    return Date.now() < this.waitingUntil.get(item.id)!;
  }

  /** True means the error was transient and the item is queued again. */
  defer(item: PlanQueueItem, error: unknown): boolean {
    if (classifyQueuePreparationError(error) !== 'transient-capacity') {
      const reason = error instanceof Error ? error.message : String(error);
      if (!this.breaker.isTrialOfSameFault(item.runId, item.id, reason)) return false;
      // A trial start during a hold: the fault is still there, and that isn't this job's fault.
      this.host.transition(item, 'queued', { detail: 'Waiting for the run to come off hold' });
      return true;
    }
    const events = this.host.history.listEvents(item.id);
    const working = events.findIndex(row => row.toState === 'working');
    const tries = (working < 0 ? events : events.slice(0, working)).filter(row => row.reason === 'capacity-wait').length;
    const notBefore = Date.now() + [30_000, 120_000, 300_000][Math.min(tries, 2)];
    const { inUse } = this.host.worktrees.worktreeUsage();
    const message = error instanceof Error ? error.message : String(error);
    const detail = /worktree/i.test(message) ? `Waiting for a free work folder (${inUse} in use)` : 'Waiting for the provider or machine to have room';
    this.host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: 'queued',
      reason: 'capacity-wait', detailHead: String(notBefore), round: item.round, tokens: 0 });
    this.waitingUntil.set(item.id, notBefore);
    this.host.transition(item, 'queued', { detail });
    return true;
  }

  failed(item: PlanQueueItem, error: unknown): void {
    this.breaker.note(item.runId, item.id, error instanceof Error ? error.message : String(error));
  }
}
