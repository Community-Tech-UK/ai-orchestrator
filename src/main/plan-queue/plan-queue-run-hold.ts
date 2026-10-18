/** Pausing retains the worktree and branch; it never goes through parking. */
import { existsSync } from 'fs';
import { UnresolvedMergeError, revertToSnapshot, snapshotTree } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { buildFixPrompt } from './plan-queue-prompts';
import { readProvisionedPaths } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

export class PlanQueueSpawnRunPaused extends Error {
  constructor(readonly instanceId?: string, options?: ErrorOptions) {
    super('This Plan Queue run is paused. Resume carries on from the same branch.', options);
  }
}

/** Lock must be held. Stop writers before checkpointing their final edits. */
export async function holdItem(
  host: PlanQueueFlowHost,
  item: PlanQueueItem,
  stopInstance: (id: string) => Promise<void>,
  restoreVerifier: (item: PlanQueueItem) => Promise<void>,
  reason = 'Paused',
): Promise<void> {
  if (!['preparing', 'working', 'fixing', 'verifying', 'awaiting-slot', 'queued'].includes(item.state)) return;
  if (item.state === 'queued' && !item.branchName && !item.worktreePath
    && !item.workerInstanceId && !item.verifierInstanceId) return;
  const verifying = item.state === 'verifying';
  const pendingInstruction = item.pendingInstruction
    ?? (item.verdict?.verdict === 'FAIL' ? buildFixPrompt(item.round, host.getRun(item.runId).config.maxRounds, item.verdict.findings)
      : item.detail && item.detail !== 'Paused' ? item.detail : null);
  await Promise.all([item.workerInstanceId, item.verifierInstanceId].filter((id): id is string => Boolean(id)).map(stopInstance));
  if (verifying) await restoreVerifier(item);
  else if (item.worktreePath && existsSync(item.worktreePath)) {
    try { item = await host.worktrees.checkpoint(item, 'paused'); }
    catch (error) { if (!(error instanceof UnresolvedMergeError)) throw error; }
  }
  const patch = {
    heldAt: item.heldAt ?? Date.now(), pendingInstruction,
    workerInstanceId: null, verifierInstanceId: null, question: null, detail: item.detail ?? reason,
  };
  const state = verifying || item.state === 'awaiting-slot' ? 'awaiting-slot' : 'queued';
  if (item.state === state) host.save({ ...item, ...patch });
  else host.transition(item, state, patch);
}

/** Recovery baseline also works when the process lost its in-memory snapshot. */
export async function restoreCheckpointAfterVerification(item: PlanQueueItem): Promise<void> {
  if (!item.worktreePath || !item.checkpointCommit || !existsSync(item.worktreePath)) return;
  const provisioned = await readProvisionedPaths(item.worktreePath);
  const isProvisioned = (file: string) => provisioned.some((p) => file === p || file.startsWith(`${p}/`));
  const current = await snapshotTree(item.worktreePath);
  await revertToSnapshot(item.worktreePath, {
    head: item.checkpointCommit,
    status: current.status.filter((line) => line.startsWith('??') && isProvisioned(line.slice(3))),
  });
}
