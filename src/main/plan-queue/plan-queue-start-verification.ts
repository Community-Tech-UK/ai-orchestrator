/** The admitted check operation, under the leader's item lock. */
import { syncItemWithBase } from './plan-queue-landing';
import { hasCheckout } from './plan-queue-orphan-checkout';
import { buildConflictPrompt } from './plan-queue-prompts';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueVerification } from './plan-queue-verification';
import type { PlanQueueItem } from './plan-queue.types';
import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';

interface StartVerificationContext {
  host: PlanQueueFlowHost;
  verification: PlanQueueVerification;
  hold(item: PlanQueueItem): Promise<void>;
  park(item: PlanQueueItem, reason: PlanQueueParkReason, detail: string): Promise<void>;
  fix(item: PlanQueueItem, prompt: string, detail: string): Promise<void>;
  spawn(item: PlanQueueItem, baseBranch: string): Promise<void>;
  /** The commands are done, so the checker's review doesn't hold the computer's one checklist turn. */
  checksFinished(): void;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function startQueueVerification(ctx: StartVerificationContext, itemId: string): Promise<void> {
  const { host, verification } = ctx;
  let item = host.getItem(itemId);
  if (item.state !== 'verifying' || item.verifierInstanceId) return;
  if (host.getRun(item.runId).status === 'paused') { await ctx.hold(item); return; }
  const run = host.getRun(item.runId);
  const baseBranch = run.config.baseBranch;
  if (!baseBranch) throw new Error(`Plan queue run ${run.id} has no base branch`);
  if (!item.worktreePath || !(await hasCheckout(item.worktreePath))) {
    try { item = await host.worktrees.reattach(item, run.workspaceCwd); }
    catch (error) {
      await ctx.park(host.getItem(item.id), 'worktree-error', `The item worktree is missing and could not be checked out again from its branch: ${message(error)}`);
      return;
    }
  }
  let shared;
  try { shared = await verification.prepareGrouped(item); }
  catch (error) {
    await ctx.park(host.getItem(item.id), 'worktree-error', `Could not run Harness checks: ${message(error)}`);
    return;
  }
  if (!shared) {
    try {
      const sync = await syncItemWithBase(item, baseBranch, run.workspaceCwd);
      if (sync.status === 'conflict') {
        await ctx.fix(item, buildConflictPrompt(baseBranch, sync.conflictFiles),
          `Merging ${baseBranch} before verification conflicted (${sync.conflictFiles.join(', ')}); sent back to the worker.`);
        return;
      }
      if (sync.status === 'merged') item = await host.worktrees.checkpoint(item, `merge ${baseBranch}`);
    } catch (error) {
      await ctx.park(host.getItem(item.id), 'merge-conflict', `Keeping the branch current failed: ${message(error)}`);
      return;
    }
  }
  const checks = shared ?? await verification.prepare(item).catch(async (error: unknown) => {
    await ctx.park(host.getItem(item.id), 'worktree-error', `Could not run Harness checks: ${message(error)}`);
    return null;
  });
  if (!checks) return;
  ctx.checksFinished();
  item = host.getItem(item.id);
  if (host.getRun(item.runId).status === 'paused') { await ctx.hold(item); return; }
  if (checks.kind === 'wait') { host.transition(item, 'awaiting-slot', { detail: checks.detail }); return; }
  if (checks.kind === 'park') { await ctx.park(item, checks.reason, checks.detail); return; }
  if (checks.kind === 'fix') { await ctx.fix(item, checks.prompt, checks.detail); return; }
  await ctx.spawn(item, baseBranch);
}
