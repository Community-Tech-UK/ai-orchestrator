/** Pausing retains the worktree and branch; an unsafe checkout parks without Git writes. */
import { NEVER_USE_HOLD_REASON } from './plan-queue-account-rules';
import { isOwnCheckout, UnresolvedMergeError, revertToSnapshot, snapshotTree } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { hasCheckout } from './plan-queue-orphan-checkout';
import { buildFixPrompt } from './plan-queue-prompts';
import { PlanQueueCheckoutOwnershipError, readProvisionedPaths } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

const USAGE_WAIT_PREFIX = 'Waiting for usage: ';

/** The note on work held because its route has no usage left; the queue tries it again later. */
export function usageWaitNote(reason: string): string {
  return `${USAGE_WAIT_PREFIX}${reason}. The queue tries again every few minutes.`;
}

/** A hold's note on the item: a status for James, never an instruction to send the worker, and cleared when held work restarts. */
export function isHoldNote(detail: string | null | undefined): boolean {
  return detail === 'Waiting for a free worktree (Harness allows 5 at once).' || detail === 'Paused' || detail === NEVER_USE_HOLD_REASON || !!detail?.startsWith(USAGE_WAIT_PREFIX);
}

/** Why a held or parked item is resumed: James's action, the queue moving it off a never-use account, or usage coming back. */
export function resumeReason(item: PlanQueueItem): string {
  if (!item.heldAt) return 'James resumed this parked item';
  if (item.detail === NEVER_USE_HOLD_REASON) return 'the queue moved this item off an account on your never-use list';
  return item.detail?.startsWith(USAGE_WAIT_PREFIX)
    ? 'it waited for usage to come back on its provider'
    : 'James resumed this paused item';
}

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
      : item.detail && !isHoldNote(item.detail) ? item.detail : null);
  await Promise.all([item.workerInstanceId, item.verifierInstanceId].filter((id): id is string => Boolean(id)).map(stopInstance));
  if (verifying) await restoreVerifier(item);
  // A half-removed folder has nothing to checkpoint; its work is on the branch.
  else if (item.worktreePath && await hasCheckout(item.worktreePath)) {
    try { item = await host.worktrees.checkpoint(item, 'paused'); }
    catch (error) {
      if (error instanceof PlanQueueCheckoutOwnershipError) {
        // Writers are stopped and the checkpoint made no Git writes. Keep the
        // refused checkout exactly as it is, without retrying parking cleanup.
        host.transition(item, 'parked', {
          heldAt: null, pendingInstruction, workerInstanceId: null, verifierInstanceId: null,
          question: null, parkReason: 'worktree-error', detail: error.message,
        });
        return;
      }
      if (!(error instanceof UnresolvedMergeError)) throw error;
    }
  }
  const patch = {
    heldAt: item.heldAt ?? Date.now(), pendingInstruction,
    // The latest hold's reason replaces an earlier hold's note; any other note stays.
    workerInstanceId: null, verifierInstanceId: null, question: null, detail: item.detail && !isHoldNote(item.detail) ? item.detail : reason,
  };
  const state = verifying || item.state === 'awaiting-slot' ? 'awaiting-slot' : 'queued';
  if (item.state === state) host.save({ ...item, ...patch });
  else host.transition(item, state, patch);
}

/**
 * Recovery baseline also works when the process lost its in-memory snapshot.
 * A missing or half-removed checkout has nothing to restore; its work is on the branch.
 */
export async function restoreCheckpointAfterVerification(item: PlanQueueItem): Promise<void> {
  if (!item.worktreePath || !item.checkpointCommit || !(await isOwnCheckout(item.worktreePath))) return;
  const provisioned = await readProvisionedPaths(item.worktreePath);
  const isProvisioned = (file: string) => provisioned.some((p) => file === p || file.startsWith(`${p}/`));
  const current = await snapshotTree(item.worktreePath);
  await revertToSnapshot(item.worktreePath, {
    head: item.checkpointCommit,
    status: current.status.filter((line) => line.startsWith('??') && isProvisioned(line.slice(3))),
  });
}
