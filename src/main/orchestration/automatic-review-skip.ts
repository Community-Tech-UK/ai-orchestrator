import type { Instance } from '../../shared/types/instance.types';

export function automaticReviewSkipReason(instance: Pick<Instance, 'id' | 'parentId' | 'metadata' | 'executionLocation'> | undefined, isLoopActive: (instanceId: string) => boolean): string | undefined {
  if (!instance) return 'no-session';
  if (instance.parentId) return 'child';
  if (instance.metadata?.['planQueueRunId']) return 'plan-queue';
  if (instance.metadata?.['automationId']) return 'automation';
  if (instance.metadata?.['pingPongReviewer']) return 'ping-pong-reviewer';
  if (isLoopActive(instance.id)) return 'active-loop';
  if (instance.executionLocation?.type === 'remote') return 'remote';
  return undefined;
}
