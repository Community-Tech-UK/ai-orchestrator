/**
 * Plan Queue boot recovery, in the order the spec fixes: put back any relaxed
 * settings, run the worktree reconciler, then bring every non-terminal item of
 * every active run back under the coordinator.
 *
 * Instances do not survive a restart with their ids, so an item whose worker
 * is gone gets a fresh worker with a resume prompt on its existing branch. A
 * verification cannot be resumed and is judged again; a landing is idempotent
 * and simply runs again.
 */

import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import { holdFromReclaim } from '../process/reclaim-holds';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueStore } from './plan-queue-store';
import { isNeverAutoRetried } from './plan-queue-park-policy';
import { restoreCheckpointAfterVerification } from './plan-queue-run-hold';
import { isLandingWait, isTerminalItemState } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { recordQueueRestart } from './plan-queue-restart-progress';
export { recoverInterruptedDocumentMerges } from './plan-queue-doc-merge';

const logger = getLogger('PlanQueueRecovery');

export interface PlanQueueRecoveryHost extends PlanQueueFlowHost {
  readonly store: PlanQueueStore;
  applyRelaxation(run: PlanQueueRun): void;
  restoreRelaxation(run: PlanQueueRun): PlanQueueRun;
  refreshAlerts(): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function recoverPlanQueue(host: PlanQueueRecoveryHost, flow: PlanQueueItemFlow): Promise<void> {
  // Restore everything first, even for runs that are still active: a crash
  // must never leave a relaxed setting in force without a live run behind it.
  for (const run of host.store.listRunsWithRelaxation()) host.restoreRelaxation(run);
  for (const run of host.store.listActiveRuns()) {
    if (run.config.relaxSettings) host.applyRelaxation(host.getRun(run.id));
  }

  try {
    await host.worktrees.cleanupScratchCopies(host.store.listWorkspaceRoots());
  } catch (error) {
    logger.warn('Plan queue check-copy cleanup failed', { error: errorMessage(error) });
  }

  try {
    await host.refreshAlerts();
  } catch (error) {
    logger.warn('Plan queue reconciler failed', { error: errorMessage(error) });
  }

  for (const run of host.store.listActiveRuns()) {
    for (const item of host.store.listItems(run.id)) {
      try {
        await recoverItem(host, flow, item);
      } catch (error) {
        logger.warn('Plan queue: item recovery failed', { itemId: item.id, error: errorMessage(error) });
      }
    }
  }
  // Harness's own landing retries run without reopening their ended runs, so the pass above doesn't see them.
  for (const item of host.store.listAutomaticLandingsInEndedRuns()) void flow.enqueueLanding(item.id);
}

async function recoverItem(host: PlanQueueRecoveryHost, flow: PlanQueueItemFlow, item: PlanQueueItem): Promise<void> {
  // Harness stopped this job on purpose and the app ended before the park finished: finish parking it.
  // Respawning its worker or re-judging it would spend the same tokens again (Decision 16a).
  if (isNeverAutoRetried(item.parkReason) && !isTerminalItemState(item.state)) {
    await flow.park(item.id, item.parkReason!, item.detail ?? 'Stopped by Harness.');
    return;
  }
  if (host.getRun(item.runId).status === 'paused' && item.state !== 'landing') {
    await flow.hold(item.id);
    return;
  }
  const worker = item.workerInstanceId ? host.instances.getInstance(item.workerInstanceId) : undefined;
  const workerAlive = Boolean(worker && !AUTOMATION_FAILURE_STATUSES.has(worker.status));
  if (workerAlive && item.workerInstanceId) {
    host.registerRole(item.workerInstanceId, { role: 'worker', runId: item.runId, itemId: item.id });
    holdFromReclaim(item.workerInstanceId, 'plan-queue');
  }
  switch (item.state) {
    case 'preparing':
      await flow.resumeAfterRestart(item);
      break;
    case 'working':
    case 'fixing':
      if (workerAlive && item.workerInstanceId) host.tracker.track(item.workerInstanceId);
      else await flow.resumeAfterRestart(item);
      break;
    case 'verifying':
      if (await recordQueueRestart(host, item) >= 3) {
        await flow.park(item.id, 'restart-loop', 'Restarted 3 times without progress. Check the saved work, then Resume.');
        break;
      }
      if (item.verifierInstanceId) await flow.stopInstance(item.verifierInstanceId);
      try { await restoreCheckpointAfterVerification(item, host.getRun(item.runId).workspaceCwd); }
      catch (error) {
        if (item.workerInstanceId) await flow.stopInstance(item.workerInstanceId);
        host.transition(item, 'parked', { parkReason: 'worktree-error', workerInstanceId: null, verifierInstanceId: null, heldAt: null,
          detail: `Could not restore the saved work after restart. Review the work folder before choosing Resume. ${errorMessage(error)}` });
        break;
      }
      host.transition(item, 'awaiting-slot', { verifierInstanceId: null });
      break;
    case 'landing':
      // A waiting landing re-checks its paths first; the landing itself runs only once they are clear.
      if (isLandingWait(item)) await flow.recheckLandingWait(item.id);
      else void flow.enqueueLanding(item.id);
      break;
    case 'landed':
      await flow.hold(item.id);
      break;
    default:
      // discovered → re-triaged by the scheduler; queued / awaiting-slot are
      // scheduled normally; needs-answer waits for James.
      break;
  }
}
