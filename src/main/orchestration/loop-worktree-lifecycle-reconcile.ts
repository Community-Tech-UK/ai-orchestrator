import { stat } from 'node:fs/promises';
import type { LoopWorktreeLifecycle } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { gitExec, gitExecSafe } from '../workspace/git/git-exec';
import {
  integrateIntoSharedBranch,
  promoteIntegrationBranch,
} from '../workspace/git/worktree-integration';
import { deleteLocalBranchIfPresent } from '../workspace/git/worktree-cleanup';
import { verifyManagedWorktreeOwnership } from '../workspace/git/worktree-cleanup';
import { removeOrphanWorktree } from './loop-worktree-reconcile';

const logger = getLogger('LoopWorktreeLifecycleReconcile');

export interface PendingManagedWorktreeLifecycle {
  id: string;
  status: string;
  workspaceCwd: string;
  worktreePath: string | null;
  branchName: string | null;
  autoIntegrateWorktree: boolean;
  lifecycle: LoopWorktreeLifecycle;
}

export interface ManagedLifecycleReconcileStore {
  getPendingWorktreeLifecycles(): PendingManagedWorktreeLifecycle[];
  updateWorktreeLifecycle(loopRunId: string, lifecycle: LoopWorktreeLifecycle): void;
  clearWorktreeInfo(loopRunId: string): void;
}

export interface ManagedLifecycleReconcileResult {
  reconciled: number;
  blocked: number;
  total: number;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function isSuccessfulStatus(status: string): boolean {
  return status === 'completed' || status === 'completed-needs-review';
}

async function branchTip(repoRoot: string, branch: string): Promise<string | null> {
  try {
    return await gitExec(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      repoRoot,
    );
  } catch {
    return null;
  }
}

async function isBranchContained(
  repoRoot: string,
  candidate: string,
  target: string,
): Promise<boolean> {
  try {
    await gitExec(['merge-base', '--is-ancestor', candidate, target], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry persisted managed-worktree finalization after a crash or forced quit.
 * Git operations are idempotent: harvest rechecks cleanliness, integration
 * skips an already-contained session branch, and promotion only fast-forwards.
 */
export async function reconcileManagedWorktreeLifecycles(
  store: ManagedLifecycleReconcileStore,
): Promise<ManagedLifecycleReconcileResult> {
  const pending = store.getPendingWorktreeLifecycles();
  let reconciled = 0;
  let blocked = 0;

  for (const row of pending) {
    let lifecycle = row.lifecycle;
    const transition = (
      phase: LoopWorktreeLifecycle['phase'],
      patch: Partial<LoopWorktreeLifecycle> = {},
    ): void => {
      lifecycle = {
        ...lifecycle,
        ...patch,
        phase,
        updatedAt: Date.now(),
      };
      row.lifecycle = lifecycle;
      store.updateWorktreeLifecycle(row.id, lifecycle);
    };

    try {
      if (lifecycle.managedByAio !== true) {
        transition('blocked', {
          lastError: 'Managed worktree ownership could not be verified',
        });
        blocked++;
        continue;
      }
      const sessionBranch = lifecycle.sessionBranch || row.branchName;
      const worktreeExists = row.worktreePath
        ? await exists(row.worktreePath)
        : false;

      if (worktreeExists && row.worktreePath) {
        if (
          !sessionBranch
          || !(await verifyManagedWorktreeOwnership({
            repoRoot: row.workspaceCwd,
            worktreePath: row.worktreePath,
            baseDir: '.worktrees',
            expectedBranch: sessionBranch,
          }))
        ) {
          transition('blocked', {
            lastError: 'Managed worktree ownership could not be verified',
          });
          blocked++;
          continue;
        }
        let dirty: string;
        try {
          dirty = (await gitExec(
            ['status', '--porcelain'],
            row.worktreePath,
          )).trim();
        } catch {
          transition('blocked', {
            lastError: 'Unable to inspect managed worktree status',
          });
          blocked++;
          continue;
        }
        if (dirty) {
          transition('harvesting', { lastError: undefined });
          await getGitWriteQueue().enqueue('boot-harvest', async () => {
            await gitExec(['add', '-A'], row.worktreePath!);
            await gitExecSafe(
              [
                'commit',
                '--no-gpg-sign',
                '-m',
                'Boot reconcile: captured managed loop session output',
              ],
              row.worktreePath!,
            );
          });
          let remainingStatus: string;
          try {
            remainingStatus = await gitExec(['status', '--porcelain'], row.worktreePath);
          } catch {
            remainingStatus = 'inspection-failed';
          }
          if (remainingStatus.trim()) {
            transition('blocked', {
              lastError: 'Harvest failed with uncommitted work',
            });
            blocked++;
            continue;
          }
          const harvestedTip = await branchTip(row.workspaceCwd, sessionBranch);
          if (!harvestedTip) {
            transition('blocked', {
              lastError: 'Managed session branch identity could not be verified',
            });
            blocked++;
            continue;
          }
          transition('harvested', { sessionTip: harvestedTip });
        } else {
          const liveTip = await branchTip(row.workspaceCwd, sessionBranch);
          if (!liveTip) {
            transition('blocked', {
              lastError: 'Managed session branch identity could not be verified',
            });
            blocked++;
            continue;
          }
          if (lifecycle.sessionTip !== liveTip) {
            transition(lifecycle.phase, { sessionTip: liveTip });
          }
        }
      }

      if (!worktreeExists && sessionBranch) {
        const currentTip = await branchTip(row.workspaceCwd, sessionBranch);
        if (
          currentTip
          && (!lifecycle.sessionTip || currentTip !== lifecycle.sessionTip)
        ) {
          transition('blocked', {
            lastError: 'Managed session branch identity could not be verified',
          });
          blocked++;
          continue;
        }
      }

      if (!isSuccessfulStatus(row.status) || !row.autoIntegrateWorktree) {
        transition('preserved', { lastError: undefined });
        if (worktreeExists && row.worktreePath) {
          if (!(await removeOrphanWorktree(
            row.workspaceCwd,
            row.worktreePath,
            sessionBranch,
          ))) {
            throw new Error('Managed worktree cleanup failed');
          }
        }
        store.clearWorktreeInfo(row.id);
        transition('cleaned');
        reconciled++;
        continue;
      }

      const integrationBranch =
        lifecycle.integrationBranch ?? `integration/${lifecycle.baseBranch}`;

      if (lifecycle.phase === 'promoted') {
        if (worktreeExists && row.worktreePath) {
          if (!(await removeOrphanWorktree(
            row.workspaceCwd,
            row.worktreePath,
            sessionBranch,
          ))) {
            throw new Error('Managed worktree cleanup failed after promotion');
          }
        }
        if (sessionBranch) {
          await deleteLocalBranchIfPresent(row.workspaceCwd, sessionBranch, {
            mergedIntoBranch: lifecycle.baseBranch,
            expectedTip: lifecycle.sessionTip ?? '',
          });
        }
        store.clearWorktreeInfo(row.id);
        transition('cleaned');
        reconciled++;
        continue;
      }

      if (!sessionBranch && lifecycle.phase !== 'integrated' && lifecycle.phase !== 'promoting') {
        transition('blocked', { lastError: 'Session branch metadata is missing' });
        blocked++;
        continue;
      }

      const integrationExists = await branchTip(row.workspaceCwd, integrationBranch);
      const phaseProvesIntegration =
        lifecycle.phase === 'integrated' || lifecycle.phase === 'promoting';
      if (phaseProvesIntegration) {
        const integrationIdentityValid = Boolean(
          integrationExists
          && lifecycle.integrationTip
          && integrationExists === lifecycle.integrationTip
          && lifecycle.sessionTip
          && await isBranchContained(
            row.workspaceCwd,
            lifecycle.sessionTip,
            integrationBranch,
          ),
        );
        if (!integrationIdentityValid) {
          transition('blocked', {
            lastError: 'Managed integration branch identity could not be verified',
          });
          blocked++;
          continue;
        }
      } else {
        if (!sessionBranch || !(await branchTip(row.workspaceCwd, sessionBranch))) {
          transition('blocked', { lastError: 'Durable session branch is missing' });
          blocked++;
          continue;
        }
        transition('integrating', {
          integrationBranch,
          lastError: undefined,
        });
        const integration = await integrateIntoSharedBranch({
          repoRoot: row.workspaceCwd,
          baseDir: '.worktrees',
          sessionBranch,
          integrationBranch,
          baseBranch: lifecycle.baseBranch,
          strategy: 'auto',
        });
        if (!integration.success) {
          transition('blocked', {
            integrationBranch,
            lastError: 'Managed worktree integration failed; inspect AIO logs',
          });
          if (worktreeExists && row.worktreePath) {
            if (await removeOrphanWorktree(
              row.workspaceCwd,
              row.worktreePath,
              sessionBranch,
            )) {
              store.clearWorktreeInfo(row.id);
            }
          }
          blocked++;
          continue;
        }
        if (!integration.mergeCommit) {
          transition('blocked', {
            integrationBranch,
            lastError: 'Managed integration branch identity could not be verified',
          });
          blocked++;
          continue;
        }
        transition('integrated', {
          integrationBranch,
          integrationTip: integration.mergeCommit,
        });
      }
      if (lifecycle.phase === 'promoting') {
        transition('integrated', {
          integrationBranch,
          integrationTip: lifecycle.integrationTip,
          lastError: undefined,
        });
      }

      transition('promoting');
      const promotion = await promoteIntegrationBranch(
        row.workspaceCwd,
        lifecycle.baseBranch,
        integrationBranch,
        lifecycle.integrationTip,
      );
      if (promotion.status === 'blocked') {
        transition('blocked', { lastError: promotion.reason });
        if (worktreeExists && row.worktreePath) {
          if (await removeOrphanWorktree(
            row.workspaceCwd,
            row.worktreePath,
            sessionBranch,
          )) {
            store.clearWorktreeInfo(row.id);
          }
        }
        blocked++;
        continue;
      }

      transition('promoted');
      if (worktreeExists && row.worktreePath) {
        if (!(await removeOrphanWorktree(
          row.workspaceCwd,
          row.worktreePath,
          sessionBranch,
        ))) {
          throw new Error('Managed worktree cleanup failed after promotion');
        }
      }
      if (sessionBranch) {
        await deleteLocalBranchIfPresent(row.workspaceCwd, sessionBranch, {
          mergedIntoBranch: lifecycle.baseBranch,
          expectedTip: lifecycle.sessionTip ?? '',
        });
      }
      store.clearWorktreeInfo(row.id);
      transition('cleaned');
      reconciled++;
    } catch (error) {
      transition(
        lifecycle.phase === 'promoted' ? 'promoted' : 'blocked',
        { lastError: 'Managed worktree recovery failed; inspect AIO logs' },
      );
      blocked++;
      logger.warn('Managed worktree lifecycle reconcile blocked', {
        loopRunId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { reconciled, blocked, total: pending.length };
}
