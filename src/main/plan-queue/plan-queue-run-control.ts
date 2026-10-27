/** Run controls serialize status changes, so Resume cannot overtake a Pause checkpoint. */
import type { PlanQueueControlPayload } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import { changeRunRouting, type PlanQueueRunRoutingChangeHost } from './plan-queue-run-routing-change';
import type { PlanQueueRoutingDeps } from './plan-queue-routing';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueRunControl');
type RunPayload = Extract<PlanQueueControlPayload, { runId: string }>;
export interface PlanQueueRunControlHost extends PlanQueueRunRoutingChangeHost {
  getRun(id: string): PlanQueueRun;
  authorize(run: PlanQueueRun, action: RunPayload['action'], caller?: string): string;
  cancel(run: PlanQueueRun, actor: string): Promise<void>;
  adopt(run: PlanQueueRun, caller?: string): void;
  requestHandover(run: PlanQueueRun, caller?: string): Promise<void>;
  handover(run: PlanQueueRun, targetInstanceId: string, caller?: string): void;
  routing?: PlanQueueRoutingDeps;
}

export class PlanQueueRunControl {
  private readonly locks = new Map<string, Promise<void>>();
  isControlling(runId: string): boolean { return this.locks.has(runId); }

  control(payload: RunPayload, caller: string | undefined, host: PlanQueueRunControlHost): Promise<void> {
    const previous = this.locks.get(payload.runId) ?? Promise.resolve();
    // sendInput may await the owner's whole turn, including its handover call.
    // Wait earlier controls, but never hold this run's lock while notifying it.
    if (payload.action === 'request-handover') return previous.then(async () => {
      const run = host.getRun(payload.runId);
      host.authorize(run, payload.action, caller);
      await host.requestHandover(run, caller);
    });
    const result = previous.then(async () => {
      const run = host.getRun(payload.runId);
      const actor = host.authorize(run, payload.action, caller);
      switch (payload.action) {
        case 'pause':
          if (run.status !== 'running' && run.status !== 'paused') break;
          host.upsertRun({ ...run, status: 'paused' });
          await host.holdRun(host.getRun(run.id));
          logger.info('Plan queue run paused', { runId: run.id, actor });
          break;
        case 'resume':
          if (run.status !== 'paused') break;
          // Retry an interrupted checkpoint/revert before allowing the scheduler to run.
          await host.holdRun(run);
          host.upsertRun({ ...host.getRun(run.id), status: 'running' });
          logger.info('Plan queue run resumed', { runId: run.id, actor });
          break;
        case 'set-routing':
          await changeRunRouting(host, run, payload.routing, caller ? 'parent' : 'panel', payload.moveInProgress, host.routing);
          break;
        case 'cancel': await host.cancel(run, actor); break;
        case 'adopt': host.adopt(run, caller); break;
        case 'handover': host.handover(run, payload.targetInstanceId, caller); break;
      }
      host.requestPump();
    });
    const tail = result.then(() => undefined, () => undefined);
    this.locks.set(payload.runId, tail);
    void tail.then(() => {
      if (this.locks.get(payload.runId) === tail) { this.locks.delete(payload.runId); host.requestPump(); }
    });
    return result;
  }
}
