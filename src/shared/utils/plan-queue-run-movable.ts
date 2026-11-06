import { planQueueIsDiscarded } from './plan-queue-discarded';

interface MovableRun {
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  items: readonly { state: string; discardedAt?: number | null }[];
}

/**
 * A run still has work for an owner: it is running or paused, or it has finished but holds
 * set-aside jobs that only its owner may resume, merge or discard. Only such a run can be moved.
 */
export function planQueueRunCanMove(run: MovableRun): boolean {
  return run.status === 'running' || run.status === 'paused'
    || run.items.some(item => item.state === 'parked' && !planQueueIsDiscarded(item));
}
