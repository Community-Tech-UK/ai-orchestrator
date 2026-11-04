/**
 * Folders a parked or landed item kept because removing them failed (a
 * checkpoint that errored, a proof that refused). Nothing else ever comes back
 * for them, so the scheduler retries them here until they go.
 */
import { getLogger } from '../logging/logger';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { hasPendingLandingCleanup } from './plan-queue-item-landing';
import { hasCheckout, retainedQueuePathExists } from './plan-queue-orphan-checkout';
import type { PlanQueueItem } from './plan-queue.types';

const logger = getLogger('PlanQueueKeptFolders');

/** How long to wait before trying the same folder again. */
export const KEPT_FOLDER_RETRY_MS = 60 * 60_000;

/** The "Worktree kept …" note parking and landing put last on the item; stale once the folder is gone. */
const KEPT_FOLDER_NOTE = /\s*Worktree kept[\s\S]*$/;

/** A parked or landed item that still records a worktree folder. Landing's own unfinished cleanup is excluded. */
export function hasKeptFolder(item: PlanQueueItem): boolean {
  return (item.state === 'parked' || item.state === 'landed') && Boolean(item.worktreePath) && !hasPendingLandingCleanup(item);
}

/**
 * Lock must be held. A parked folder is saved to its branch first, exactly as
 * parking does, and the branch is always kept for Resume. A landed folder is
 * never checkpointed: edits made after landing are unlanded work, so the proof
 * refuses it and it stays. Unfinished merges and broken checkouts throw or are
 * refused and stay too. Only the folder is removed; a landed branch is then
 * deleted as landing cleanup would have done.
 */
export async function retryKeptFolder(host: PlanQueueFlowHost, itemId: string): Promise<void> {
  let item = host.getItem(itemId);
  if (!hasKeptFolder(item)) return;
  const worktreePath = item.worktreePath!;
  const repoRoot = host.getRun(item.runId).workspaceCwd;
  if (!(await hasCheckout(worktreePath))) {
    // Gone already: only the record is stale. A half-removed folder is left for Resume's repair.
    if (!(await retainedQueuePathExists(worktreePath))) host.save({ ...item, worktreePath: null, detail: withoutKeptNote(item.detail) });
    return;
  }
  if (item.state === 'parked') item = await host.worktrees.checkpoint(item, 'parked: folder removal retried');
  const removal = await host.worktrees.removeWithProof(item, repoRoot);
  if (!removal.removed) {
    logger.info('Plan queue: a kept folder still cannot be removed; trying again later', { itemId, reason: removal.reason, detail: removal.detail });
    return;
  }
  item = host.save({ ...host.getItem(itemId), detail: withoutKeptNote(host.getItem(itemId).detail) });
  logger.info('Plan queue: removed a folder an earlier clean-up had to keep', { itemId, worktreePath });
  // A landed branch is deleted as landing cleanup would have done; like there, a refusal only warns.
  if (item.state === 'landed' && item.branchName) {
    await host.worktrees.deleteBranchWithProof(item, repoRoot).catch((error: unknown) => logger.warn('Plan queue: landed branch was not deleted', {
      itemId, error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/** Retries every kept folder that is due, each under its item's lock; failures wait for the next due time. */
export class PlanQueueKeptFolders {
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly host: PlanQueueFlowHost,
    private readonly lock: (itemId: string, action: () => Promise<void>) => Promise<void>,
  ) {}

  retryDue(items: readonly PlanQueueItem[], now = Date.now()): void {
    for (const item of items) {
      if (!hasKeptFolder(item) || (this.retryAt.get(item.id) ?? 0) > now) continue;
      this.retryAt.set(item.id, now + KEPT_FOLDER_RETRY_MS);
      void this.lock(item.id, () => retryKeptFolder(this.host, item.id)).catch((error: unknown) => {
        logger.info('Plan queue: a kept folder still cannot be removed; trying again later', {
          itemId: item.id, error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}

function withoutKeptNote(detail: string | null): string | null {
  return detail?.replace(KEPT_FOLDER_NOTE, '') || null;
}
