import { rmSync } from 'node:fs';
import { isActiveLoopRuntimeState } from './loop-runtime-status';
import { LoopCoordinator } from './loop-coordinator';

/**
 * Shared afterEach cleanup for LoopCoordinator specs.
 *
 * Cancels only non-terminal loops, then deletes the temp workspace. Bound so a
 * stuck chokidar close cannot trip Vitest's default 10s hookTimeout during
 * pre-push. Terminal loops are left alone — cancelLoop is a no-op for them and
 * re-entering cleanup just burns hook budget.
 */
export async function cleanupLoopCoordinatorSpec(args: {
  coordinator: LoopCoordinator;
  workspace?: string | null;
  reset?: boolean;
}): Promise<void> {
  const { coordinator, workspace, reset = true } = args;
  const active = coordinator.getActiveLoops().filter((loop) => isActiveLoopRuntimeState(loop));
  await Promise.all(active.map((loop) => coordinator.cancelLoop(loop.id).catch(() => undefined)));
  if (workspace) {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* noop — watcher may still be releasing; next GC/tmp sweep cleans up */
    }
  }
  if (reset) {
    LoopCoordinator._resetForTesting();
  }
}
