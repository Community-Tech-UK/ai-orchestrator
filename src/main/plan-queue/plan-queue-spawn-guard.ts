import { assertQueueCheckout, InvalidQueueCheckoutError } from './plan-queue-orphan-checkout';
import type { PlanQueueItem } from './plan-queue.types';

/**
 * A worker or checker is started with full file access in its job's work folder, so the folder must be
 * proved to be that job's own checkout first (registered with this repository, on the job's branch). A
 * missing folder is refused too: there is no fallback to the root checkout. Throws InvalidQueueCheckoutError.
 */
export async function requireOwnWorkFolder(item: PlanQueueItem, repoRoot: string): Promise<string> {
  if (!item.worktreePath || !item.branchName) {
    throw new InvalidQueueCheckoutError({ cause: new Error('The job has no work folder of its own') });
  }
  await assertQueueCheckout(item.worktreePath, item.branchName, repoRoot);
  return item.worktreePath;
}
