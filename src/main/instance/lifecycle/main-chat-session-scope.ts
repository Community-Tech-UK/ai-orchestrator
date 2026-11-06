import type { Instance } from '../../../shared/types/instance.types';

export type MainChatSessionScope = Pick<Instance, 'parentId' | 'executionLocation' | 'metadata'>;

/** Shared scope for chat-only features; automatic review may also exclude a live loop. */
export function mainChatSessionSkipReason(instance: MainChatSessionScope, isLoopActive = false): string | null {
  if (instance.parentId) return 'child';
  const metadata = instance.metadata;
  if (metadata?.['planQueueRunId'] || metadata?.['planQueueItemId'] || metadata?.['planQueueRole'] || metadata?.['spendPurpose'] === 'plan-queue') return 'plan-queue';
  if (metadata?.['automationId'] || metadata?.['automationRunId'] || metadata?.['spendPurpose'] === 'automation') return 'automation';
  if (metadata?.['repoJobId'] || metadata?.['spendPurpose'] === 'repo-job') return 'repo-job';
  if (metadata?.['pingPongReviewer'] === true) return 'ping-pong-reviewer';
  if (isLoopActive) return 'active-loop';
  if (instance.executionLocation.type === 'remote') return 'remote';
  return null;
}

export function isMainChatSession(instance: MainChatSessionScope, isLoopActive = false): boolean {
  return mainChatSessionSkipReason(instance, isLoopActive) === null;
}
