import type { ExecutionLocation } from '../../../shared/types/worker-node.types';

/**
 * Whether a successful instance spawn should pre-warm a replacement CLI
 * process for the same provider.
 *
 * - Resume restores are skipped: the spare process only serves future fresh
 *   sessions but expires on a 5-minute TTL while the restored session idles.
 * - Remote instances are skipped: their working directory lives on another
 *   machine, so a local pre-warm would spawn with a nonexistent cwd and fail
 *   with a misleading `spawn <cli> ENOENT`.
 * - A missing `executionLocation` (legacy/persisted instances) is treated as
 *   local.
 */
export function shouldPreWarmReplacement(
  resume: boolean | undefined,
  executionLocation: ExecutionLocation | undefined,
): boolean {
  if (resume) {
    return false;
  }
  return executionLocation?.type !== 'remote';
}
