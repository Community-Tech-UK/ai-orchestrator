import { getLogger } from '../logging/logger';
import type { LoopState } from '../../shared/types/loop.types';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import { getLoopStore } from './loop-store';

const logger = getLogger('LoopCoordinator');

export function cleanupLoopWorktreeAfterTerminate(args: {
  state: LoopState;
  status: LoopState['status'];
  worktreeSessionId: string | undefined;
  getTerminalCleanup: (loopRunId: string) => Promise<void> | undefined;
}): void {
  const { state, status, worktreeSessionId, getTerminalCleanup } = args;
  if (!worktreeSessionId) return;

  void (async () => {
    try {
      const worktreeManager = getWorktreeManager();
      const isSuccess = status === 'completed' || status === 'completed-needs-review';
      // Yield to the synchronous caller so it can register the adapter cleanup
      // hook and store its promise in terminalCleanupPromises before we proceed.
      // Without this yield the promise map is empty when we look it up below.
      await Promise.resolve();
      // Wait for the adapter (CLI child) to fully stop BEFORE harvesting.
      // Decision C ordering: stop child -> harvest -> reap. If we harvest while
      // the child is still alive it can write files after our commit snapshot,
      // and those post-harvest writes would be silently deleted by cleanup.
      const adapterDonePromise = getTerminalCleanup(state.id);
      if (adapterDonePromise) {
        try {
          await adapterDonePromise;
        } catch {
          // Adapter cleanup errors are already logged; proceed to harvest.
        }
      }
      // Now harvest: commit any uncommitted agent work to the session branch so
      // the branch is durable and reachable after the worktree is reaped.
      // harvestWorktree is a no-op when there's nothing to commit.
      const harvestResult = await worktreeManager.harvestWorktree(worktreeSessionId);
      if (!harvestResult.committed && harvestResult.hasUncommittedWork) {
        // Harvest failed but there is uncommitted agent work. Skip forced
        // removal to avoid data loss; the worktree stays on disk for manual
        // inspection. The next boot reconcile can reap it after operator review.
        logger.error('Loop terminate: harvest failed with uncommitted work - skipping worktree removal to preserve agent output', undefined, {
          loopRunId: state.id,
          worktreeSessionId,
          status,
        });
        return;
      }
      // Auto-integration (Decision C): on terminal-success, merge the harvested
      // session branch into the shared integration branch via a dedicated
      // integration worktree. On conflict, branches stay untouched for manual
      // resolution; the worktree dir is still reaped because work is committed.
      if (isSuccess && state.config.autoIntegrateWorktree !== false) {
        try {
          const integration = await worktreeManager.integrateWorktree(worktreeSessionId, {
            advanceBaseIfUnchecked: true,
          });
          if (integration.success) {
            logger.info('Loop terminate: auto-integrated session branch', {
              loopRunId: state.id,
              worktreeSessionId,
              integrationBranch: integration.integrationBranch,
              mergeCommit: integration.mergeCommit,
              alreadyIntegrated: integration.alreadyIntegrated ?? false,
              baseAdvanced: integration.baseAdvanced ?? false,
            });
          } else {
            logger.warn('Loop terminate: auto-integration conflict - session branch preserved for manual resolution', {
              loopRunId: state.id,
              worktreeSessionId,
              integrationBranch: integration.integrationBranch,
              conflictFiles: integration.conflictFiles,
            });
          }
        } catch (integErr) {
          logger.warn('Loop terminate: auto-integration failed (best-effort)', {
            loopRunId: state.id,
            worktreeSessionId,
            error: integErr instanceof Error ? integErr.message : String(integErr),
          });
        }
      }
      if (!isSuccess) {
        // Non-success: mark abandoned so the branch is kept and callers know
        // this worktree was not cleanly completed.
        await worktreeManager.abandonWorktree(worktreeSessionId, `loop-${status}`);
      }
      // Do NOT use { force: true }. On success, harvest already committed all
      // changes so the worktree is clean; on non-success, abandonWorktree marks
      // the session as pre-cleared. Neither path needs a forced removal.
      await worktreeManager.cleanupWorktree(worktreeSessionId);
      // Clear DB registry columns so next boot does not try to reap it again.
      try { getLoopStore().clearWorktreeInfo(state.id); } catch { /* best-effort */ }
      logger.info('Loop terminate: worktree cleaned up', { loopRunId: state.id, worktreeSessionId, status });
    } catch (err) {
      logger.warn('Loop terminate: worktree cleanup failed (best-effort)', {
        loopRunId: state.id,
        worktreeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
