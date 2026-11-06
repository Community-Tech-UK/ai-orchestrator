import type { Instance } from '../../shared/types/instance.types';
import { machineSessionReasonOf } from '../../shared/utils/machine-session';

/**
 * Why an automatic review must not start for this session, or undefined when it
 * may. Instance markers (child, plan-queue, automation, repo-job, node-run,
 * ping-pong reviewer) all come from `machineSessionReasonOf`, the one
 * classifier shared with spend tagging and the warm-start block, so the
 * definitions cannot drift. The loop and remote checks are specific to review.
 */
export function automaticReviewSkipReason(instance: Pick<Instance, 'id' | 'parentId' | 'metadata' | 'executionLocation'> | undefined, isLoopActive: (instanceId: string) => boolean): string | undefined {
  if (!instance) return 'no-session';
  const machineReason = machineSessionReasonOf(instance);
  if (machineReason) return machineReason;
  if (isLoopActive(instance.id)) return 'active-loop';
  if (instance.executionLocation?.type === 'remote') return 'remote';
  return undefined;
}
