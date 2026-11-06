export { SPEND_PURPOSE_LABELS } from '../../../shared/types/spend-purpose-labels';

/** Purpose for an instance turn, independent of its legacy chat/child task type. */
export const SPEND_PURPOSES = ['chat', 'child', 'plan-queue', 'repo-job', 'remote-node',
  'review', 'automation', 'channel', 'quick-ask'] as const;
export type SpendPurpose = typeof SPEND_PURPOSES[number];
const instancePurposes = new Set<string>(SPEND_PURPOSES);
const PLAN_QUEUE_ROLES = new Set<string>(['worker', 'verifier', 'triage']);

export interface ResolvedSpendPurpose {
  purpose: SpendPurpose;
  purposeDetail?: string;
}

export function resolveSpendPurpose(instance: {
  parentId?: string | null;
  metadata?: Record<string, unknown>;
} | undefined): ResolvedSpendPurpose {
  const metadata = instance?.metadata ?? {};
  const explicit = metadata['spendPurpose'];
  if (typeof explicit === 'string' && instancePurposes.has(explicit)) {
    return { purpose: explicit as SpendPurpose };
  }
  const role = metadata['planQueueRole'];
  if (typeof role === 'string' && PLAN_QUEUE_ROLES.has(role)) {
    return { purpose: 'plan-queue', purposeDetail: role };
  }
  if (metadata['pingPongReviewer'] === true) return { purpose: 'review' };
  if (metadata['planQueueRunId']) return { purpose: 'plan-queue' };
  if (metadata['automationId']) return { purpose: 'automation' };
  if (metadata['spawnParentInstanceId']) return { purpose: 'remote-node' };
  if (instance?.parentId) return { purpose: 'child' };
  return { purpose: 'chat' };
}
