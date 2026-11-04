/** Queue-specific backoff and a circuit for identical failures across jobs. */
import { WorktreeCapacityError } from '../workspace/git/worktree-manager';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItem } from './plan-queue.types';

export function classifyQueuePreparationError(error: unknown): 'transient-capacity' | 'this-job' {
  if (error instanceof WorktreeCapacityError || error instanceof Error && error.cause instanceof WorktreeCapacityError) return 'transient-capacity';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return ['EAGAIN', 'EMFILE', 'ENFILE', 'EBUSY'].includes(code)
    || /Maximum concurrent worktrees|resource governor|load gate|provider.*(?:at capacity|concurrency)|too many concurrent/i.test(message)
    ? 'transient-capacity' : 'this-job';
}
export function isTransientQueueTurnFailure(reason: string): boolean {
  return /transport closed|provider (?:returned )?5\d\d|adapter not spawned|timed out waiting for the turn to accept/i.test(reason);
}

export class PlanQueuePreparationErrors {
  private readonly failures = new Map<string, { itemId: string; reason: string }>();
  private readonly waitingUntil = new Map<string, number>();
  constructor(private readonly host: PlanQueueFlowHost) {}

  succeeded(runId: string, itemId: string): void { this.failures.delete(runId); this.waitingUntil.set(itemId, 0); }
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
    if (classifyQueuePreparationError(error) !== 'transient-capacity') return false;
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
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
    const previous = this.failures.get(item.runId);
    this.failures.set(item.runId, { itemId: item.id, reason });
    if (previous?.itemId !== item.id && previous?.reason === reason) {
      this.host.pauseForSharedError(item.runId, `Paused: every job fails with the same error: ${reason}. Fix it, then press Resume.`);
    }
  }
}
