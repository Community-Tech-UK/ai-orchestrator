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

import { existsSync } from 'fs';
import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import { holdFromReclaim } from '../process/reclaim-holds';
import { revertToSnapshot, snapshotTree } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueStore } from './plan-queue-store';
import { readProvisionedPaths } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

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
}

async function recoverItem(host: PlanQueueRecoveryHost, flow: PlanQueueItemFlow, item: PlanQueueItem): Promise<void> {
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
      if (item.verifierInstanceId) flow.retireInstance(item.verifierInstanceId);
      await restoreCheckpointAfterVerification(item);
      host.transition(item, 'awaiting-slot', { verifierInstanceId: null });
      break;
    case 'landing':
      void flow.enqueueLanding(item.id);
      break;
    default:
      // discovered → re-triaged by the scheduler; queued / awaiting-slot are
      // scheduled normally; needs-answer waits for James.
      break;
  }
}

/**
 * The live tree guard's snapshot is in memory, so it dies with the process. A
 * verification only starts from a clean checkpoint (the worker's turn and any
 * merge were checkpointed first), so anything in the worktree beyond that
 * checkpoint and the provisioned files is the dead verifier's. Put the tree
 * back, or the next verifier would snapshot those edits as its baseline and
 * they would land with the item. The revert also abandons a merge left by a
 * crash between a conflicted merge of the base and the move to `fixing`; the
 * next verification redoes that merge.
 */
async function restoreCheckpointAfterVerification(item: PlanQueueItem): Promise<void> {
  if (!item.worktreePath || !item.checkpointCommit || !existsSync(item.worktreePath)) return;
  const provisioned = await readProvisionedPaths(item.worktreePath);
  const isProvisioned = (file: string) => provisioned.some((p) => file === p || file.startsWith(`${p}/`));
  const current = await snapshotTree(item.worktreePath);
  await revertToSnapshot(item.worktreePath, {
    head: item.checkpointCommit,
    status: current.status.filter((line) => line.startsWith('??') && isProvisioned(line.slice(3))),
  });
}
