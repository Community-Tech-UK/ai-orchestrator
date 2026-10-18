import type { LoopCoordinator } from './loop-coordinator';
import type { LoopStore } from './loop-store';

/** Close persisted recovery metadata only after live cancellation has declined. */
export async function cancelLoopOrCloseStoredRun(
  loopRunId: string,
  coordinator: Pick<LoopCoordinator, 'cancelLoop' | 'getLoop'>,
  store: Pick<LoopStore, 'closeStoredRun'>,
): Promise<boolean> {
  if (await coordinator.cancelLoop(loopRunId)) return true;
  if (coordinator.getLoop(loopRunId)) return false;
  return store.closeStoredRun(loopRunId);
}
