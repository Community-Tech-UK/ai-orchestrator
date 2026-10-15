import { getPlanQueueCoordinator } from '../../plan-queue/plan-queue-coordinator';
import { stopLoopsForSessions } from '../../orchestration/loop-stop-for-sessions';

export async function prepareUserClose(ids: readonly string[], scope: 'one' | 'all', deps: {
  stopLoops: (ids: readonly string[]) => Promise<number>;
  queue: { isInitialized(): boolean; noteUserClosing(ids: readonly string[], scope: 'one' | 'all'): number };
} = { stopLoops: stopLoopsForSessions, queue: getPlanQueueCoordinator() }): Promise<{ loopsStopped: number; planQueueRunsPaused: number }> {
  // Pause before the first await: removal events and existing scheduler turns may run meanwhile.
  const planQueueRunsPaused = deps.queue.isInitialized() ? deps.queue.noteUserClosing(ids, scope) : 0;
  const loopsStopped = await deps.stopLoops(ids);
  return { loopsStopped, planQueueRunsPaused };
}
