/**
 * Plan Queue push guard for sessions that run on a worker node.
 *
 * The guard's git settings include a blocked push address for every remote that has its own, and
 * those remotes live in the node's copy of the repository, which this machine cannot read. So a
 * remote queue session carries only a flag; the node builds the guard itself when it starts the
 * session (`LocalInstanceManager.spawn`). A worker that does not advertise `queuePushGuard: 1`
 * would drop the flag and start the session unguarded, so it is refused there instead.
 */
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';

/** The `queuePushGuard` capability value whose wire shape this coordinator sends. */
export const REMOTE_QUEUE_PUSH_GUARD_PROTOCOL = 1;

export const REMOTE_QUEUE_PUSH_GUARD_UNSUPPORTED =
  'This worker is out of date, so Harness cannot stop a queued session from pushing code on it. Update the worker, or run the queue on this computer.';

/**
 * Fail closed: a queue session must never reach a worker that would start it without the guard.
 * Called when the adapter is created and again when it spawns, because the node may have
 * re-registered on an older build in between.
 */
export function assertRemoteQueuePushGuardSupported(
  options: Pick<UnifiedSpawnOptions, 'queuePushGuard'>,
  capabilities: Pick<WorkerNodeCapabilities, 'queuePushGuard'> | undefined,
): void {
  // Registration capabilities reach the registry unparsed: accept only the exact value.
  if (options.queuePushGuard && capabilities?.queuePushGuard !== REMOTE_QUEUE_PUSH_GUARD_PROTOCOL) {
    throw new Error(REMOTE_QUEUE_PUSH_GUARD_UNSUPPORTED);
  }
}
