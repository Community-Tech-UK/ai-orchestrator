import { isTransientQueueTurnFailure } from './plan-queue-failure-class';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItem } from './plan-queue.types';

/** Two bounded retries in the same session; pause/shutdown cancels the wait. */
export class PlanQueueTurnRetries {
  private readonly attempts = new Map<string, number>();
  private readonly waiting = new Map<string, AbortController>();
  constructor(private readonly host: PlanQueueFlowHost) {}
  cancel(itemId: string): void { this.waiting.get(itemId)?.abort(); }
  cancelAll(): void { for (const controller of this.waiting.values()) controller.abort(); }
  completed(instanceId: string): void { this.attempts.delete(instanceId); }
  async retry(item: PlanQueueItem, instanceId: string, reason: string): Promise<boolean> {
    if (!isTransientQueueTurnFailure(reason)) return false;
    const controller = new AbortController();
    this.waiting.set(item.id, controller);
    try {
      while ((this.attempts.get(instanceId) ?? 0) < 2) {
        const attempt = this.attempts.get(instanceId) ?? 0;
        this.attempts.set(instanceId, attempt + 1);
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, [15_000, 45_000][attempt]);
          controller.signal.addEventListener('abort', finish, { once: true });
          if (controller.signal.aborted) finish();
        });
        const current = this.host.getItem(item.id);
        if (controller.signal.aborted || this.host.tracker.isShuttingDown() || this.host.getRun(item.runId).status !== 'running'
          || current.workerInstanceId !== instanceId || !['working', 'fixing'].includes(current.state)) return true;
        try {
          this.host.tracker.beginTurn(instanceId);
          await this.host.instances.sendInput(instanceId, 'Finish the item with a real result.', undefined, { automatedInput: true, internalSource: 'plan-queue' });
          return true;
        } catch (error) {
          if (!isTransientQueueTurnFailure(error instanceof Error ? error.message : String(error))) return false;
        }
      }
      return false;
    } finally { this.waiting.delete(item.id); }
  }
}
