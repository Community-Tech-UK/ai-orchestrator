import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { PRE_START_STATES } from './plan-queue-readiness';
import { isTerminalItemState } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueRunParent');
export interface ParentDeps {
  instances: Pick<PlanQueueInstancePort, 'getInstance' | 'getAllInstances'>;
  isQueueInstance: (id: string) => boolean;
  getRun: (id: string) => PlanQueueRun;
  /** The only writer of the parent columns after insert (PlanQueueStore.setRunParent). */
  setParent: (runId: string, parentInstanceId: string, parentHistoryThreadId: string | null) => void;
  onParentChanged?: (run: PlanQueueRun) => void;
}

/** A restored conversation takes its run back before answers, control or worker nesting. */
export function resolveRunParent(run: PlanQueueRun, deps: ParentDeps): string | undefined {
  // Worker/verifier operations may have awaited while another session adopted the run.
  const current = deps.getRun(run.id);
  run.parentInstanceId = current.parentInstanceId;
  run.parentHistoryThreadId = current.parentHistoryThreadId;
  if (deps.instances.getInstance(current.parentInstanceId)) return current.parentInstanceId;
  const thread = current.parentHistoryThreadId?.trim();
  const restored = thread ? deps.instances.getAllInstances().find((instance) =>
    instance.historyThreadId?.trim() === thread && !deps.isQueueInstance(instance.id)
      && !AUTOMATION_FAILURE_STATUSES.has(instance.status)) : undefined;
  if (!restored) {
    logger.debug('Plan queue owner is not live', { runId: run.id, parentInstanceId: run.parentInstanceId });
    return undefined;
  }
  const previousParentId = run.parentInstanceId;
  deps.setParent(run.id, restored.id, current.parentHistoryThreadId);
  // Keep this synchronous caller's run snapshot consistent with the persisted ownership.
  run.parentInstanceId = restored.id;
  logger.info('Plan queue run rebound to the restored parent conversation', {
    runId: run.id, previousParentId, parentInstanceId: restored.id,
  });
  deps.onParentChanged?.(run);
  return restored.id;
}

/** Authority has already confirmed the run is stranded and the caller is a non-queue session. */
export function adoptRunParent(run: PlanQueueRun, callerId: string | undefined, deps: ParentDeps & {
  items: PlanQueueItem[];
  notifyParent: (run: PlanQueueRun, message: string) => void;
}): void {
  const caller = callerId ? deps.instances.getInstance(callerId) : undefined;
  if (!caller || deps.isQueueInstance(caller.id)) throw new Error('Adopt requires a live session that the queue did not spawn');
  const adopted = { ...deps.getRun(run.id), parentInstanceId: caller.id, parentHistoryThreadId: caller.historyThreadId?.trim() || null };
  deps.setParent(adopted.id, adopted.parentInstanceId, adopted.parentHistoryThreadId);
  logger.info('Plan queue run adopted by a new parent session', { runId: run.id,
    previousParentId: run.parentInstanceId, parentInstanceId: caller.id });
  deps.onParentChanged?.(adopted);
  const waiting = deps.items.filter((item) => PRE_START_STATES.has(item.state)).length;
  const inProgress = deps.items.filter((item) => !PRE_START_STATES.has(item.state) && !isTerminalItemState(item.state)).length;
  deps.notifyParent(adopted, `You now own Plan Queue run ${run.id.slice(0, 8)}: ${waiting} items waiting, ${inProgress} in progress.`);
}
