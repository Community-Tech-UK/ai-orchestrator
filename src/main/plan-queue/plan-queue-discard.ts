/**
 * Keeps a way back from Discard. Deleting a branch can orphan the only copy of finished work, and
 * git eventually removes orphaned commits, so a discard that may hold work first writes a reference
 * here. These references are never mixed with `RESCUE_REF_PREFIX`, which holds James's own files
 * from failed landings and must not expire.
 */
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { isOwnCheckout } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { quarantineOrphanCheckout, retainedQueuePathExists } from './plan-queue-orphan-checkout';
import { inspectSetAsideWork } from './plan-queue-set-aside';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { planQueueBranchName } from './plan-queue-worktree';

const logger = getLogger('PlanQueueDiscard');

export const DISCARDED_REF_PREFIX = 'refs/plan-queue/discarded/';
/** How long discarded work can be brought back. */
export const DISCARDED_WORK_KEPT_MS = 30 * 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;

const discardedRef = (itemId: string): string => `${DISCARDED_REF_PREFIX}${itemId}`;
const refTip = (ref: string, cwd: string): Promise<string> => gitExec(['for-each-ref', '--format=%(objectname)', ref], cwd);

/**
 * Call before the branch is deleted, under the item's lock. Returns when the reference expires, or
 * null when there was nothing worth keeping. Throws, so the branch stays, if a branch about to be
 * deleted could not be kept. With no branch nothing is being deleted, so failing to write the
 * reference there only logs.
 */
export async function keepDiscardedWork(item: PlanQueueItem, run: PlanQueueRun, now: number): Promise<number | null> {
  const repoRoot = run.workspaceCwd;
  const branchTip = item.branchName ? await refTip(`refs/heads/${item.branchName}`, repoRoot) : '';
  const ref = discardedRef(item.id);
  const expiresAt = now + DISCARDED_WORK_KEPT_MS;
  // After a crash mid-discard the branch is gone and the reference holds its tip; the checkpoint may be older.
  if (!branchTip && await refTip(ref, repoRoot)) return expiresAt;
  const tip = branchTip || item.checkpointCommit;
  if (!tip) return null;
  const { holding } = await inspectSetAsideWork({ ...item, worktreePath: null }, run);
  if (holding === 'nothing' || holding === 'nothing-new') return null;
  return getGitWriteQueue().enqueue('plan-queue-keep-discarded', async () => {
    try {
      await gitExec(['update-ref', ref, tip], repoRoot);
      return expiresAt;
    } catch (error) {
      if (branchTip) throw new Error(`Its work could not be kept (${String(error)})`, { cause: error });
      logger.warn('Could not keep a discarded checkpoint', { itemId: item.id, error: String(error) });
      return null;
    }
  });
}

type DiscardHost = Pick<PlanQueueFlowHost, 'getItem' | 'getRun' | 'save' | 'worktrees'>;

/** Removes the worktree, keeps the work, then deletes the branch. Returns when the kept work expires. */
async function clearAway(host: DiscardHost, parked: PlanQueueItem): Promise<number | null> {
  let item = parked;
  const run = host.getRun(item.runId);
  if (item.worktreePath && await isOwnCheckout(item.worktreePath)) {
    await host.worktrees.retireForDiscard(item, run.workspaceCwd);
    item = host.getItem(item.id);
  }
  // Whatever is left there is a broken checkout, which is moved aside rather than removed.
  if (item.worktreePath && await retainedQueuePathExists(item.worktreePath)) {
    item = await quarantineOrphanCheckout(item, run.workspaceCwd, planQueueBranchName(item), (next) => { host.save(next); });
  }
  const cleared = item.worktreePath ? host.save({ ...item, worktreePath: null }) : item;
  const discardRefExpiresAt = await keepDiscardedWork(cleared, run, Date.now());
  if (cleared.branchName) await host.worktrees.deleteBranchWithProof(cleared, run.workspaceCwd, { discardRequested: true });
  return discardRefExpiresAt;
}

/**
 * A discard always takes the job off the list. Nothing is deleted until its work is safe, so anything
 * git will not release stays on disk, and the job's detail says why. Call under the item's lock with
 * its sessions stopped.
 */
export async function discardParkedItem(host: DiscardHost, parked: PlanQueueItem, actor: string): Promise<void> {
  const discarded = { discardedAt: Date.now(), discardedBy: actor };
  try {
    const discardRefExpiresAt = await clearAway(host, parked);
    host.save({ ...host.getItem(parked.id), ...discarded, discardRefExpiresAt });
  } catch (error) {
    logger.warn('Discarded a job but could not clear everything away', { itemId: parked.id, error: String(error) });
    const item = host.getItem(parked.id);
    const detail = `${item.detail ?? ''}\nLeft in place when discarded: ${error instanceof Error ? error.message : String(error)}`.trim();
    host.save({ ...item, ...discarded, discardRefExpiresAt: null, detail: detail.slice(0, 8000) });
  }
}

/** Resume of a discarded job carries on from its kept work, if any. Call under the item's lock. */
export async function restoreBeforeResume(host: Pick<PlanQueueFlowHost, 'getItem' | 'getRun' | 'save'>, itemId: string): Promise<void> {
  const item = host.getItem(itemId);
  if (!item.discardedAt) return;
  const repoRoot = host.getRun(item.runId).workspaceCwd;
  if (await refTip(discardedRef(item.id), repoRoot) || await refTip(`refs/heads/${planQueueBranchName(item)}`, repoRoot)) await restoreDiscardedWork(host, itemId);
}

/** Undo: put the branch back and return the job to Set aside. Call under the item's lock. */
export async function restoreDiscardedWork(host: Pick<PlanQueueFlowHost, 'getItem' | 'getRun' | 'save'>, itemId: string): Promise<void> {
  const item = host.getItem(itemId);
  if (!item.discardedAt) throw new Error('Only a discarded job can be restored');
  const repoRoot = host.getRun(item.runId).workspaceCwd;
  const ref = discardedRef(item.id);
  const branchName = planQueueBranchName(item);
  await getGitWriteQueue().enqueue('plan-queue-restore-discarded', async () => {
    // A discard that could not delete the branch left the work there, and it may have moved on since.
    const existing = await refTip(`refs/heads/${branchName}`, repoRoot);
    const kept = await refTip(ref, repoRoot);
    if (!existing && !kept) throw new Error('This job\'s work was not kept, so it cannot be restored');
    if (!existing) await gitExec(['branch', branchName, kept], repoRoot);
    host.save({ ...host.getItem(itemId), branchName, discardedAt: null, discardedBy: null, discardRefExpiresAt: null });
    // A branch that moved on may not contain the kept commits, so that reference stays.
    if (!existing || existing === kept) await gitExec(['update-ref', '-d', ref], repoRoot);
  });
}

/** Hourly: removes references past their date, and dates any reference that has none. */
export class PlanQueueDiscardedRefs {
  private nextSweepAt = 0;

  constructor(
    private readonly host: Pick<PlanQueueFlowHost, 'store' | 'save'>,
    private readonly lock: (itemId: string, action: () => Promise<void>) => Promise<void>,
  ) {}

  sweepDue(folders: () => readonly string[], now = Date.now()): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_EVERY_MS;
    void this.sweep(folders(), now).catch((error: unknown) => logger.warn('Plan queue: could not sweep discarded work', { error: String(error) }));
  }

  async sweep(folders: readonly string[], now: number): Promise<void> {
    for (const folder of folders) {
      // A project folder can be gone or unreadable; its references wait for the next sweep.
      const listed = await gitExec(['for-each-ref', '--format=%(refname)', DISCARDED_REF_PREFIX], folder).catch(() => '');
      for (const ref of listed.split('\n').filter(Boolean)) {
        const itemId = ref.slice(DISCARDED_REF_PREFIX.length);
        await this.lock(itemId, () => this.settle(itemId, ref, folder, now)).catch((error: unknown) => {
          logger.warn('Plan queue: could not settle discarded work', { itemId, error: String(error) });
        });
      }
    }
  }

  private async settle(itemId: string, ref: string, folder: string, now: number): Promise<void> {
    const item = this.host.store.getItem(itemId);
    // Without its job there is no date to go by, so the reference stays.
    if (!item) return;
    if (!item.discardedAt) {
      // A restore that stopped leaves the work on the branch, and this can go. A discard that stopped
      // has already deleted the branch, so this is the only copy and it stays.
      const onBranch = await refTip(`refs/heads/${planQueueBranchName(item)}`, folder);
      if (onBranch && onBranch === await refTip(ref, folder)) await this.remove(ref, folder);
      return;
    }
    if (!item.discardRefExpiresAt) {
      this.host.save({ ...item, discardRefExpiresAt: now + DISCARDED_WORK_KEPT_MS });
      return;
    }
    if (item.discardRefExpiresAt > now) return;
    await this.remove(ref, folder);
    this.host.save({ ...item, discardRefExpiresAt: null });
  }

  private remove(ref: string, folder: string): Promise<void> {
    return getGitWriteQueue().enqueue('plan-queue-sweep-discarded', async () => { await gitExec(['update-ref', '-d', ref], folder); });
  }
}
