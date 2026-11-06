import { isAutomaticCopilotOrigin, type CopilotInvocationOrigin } from '../types/copilot-account.types';
export const MACHINE_SESSION_REASONS = ['loop', 'review', 'verification', 'consensus', 'workflow', 'automation', 'failover', 'internal', 'child', 'plan-queue', 'ping-pong-review', 'node-run', 'repo-job'] as const;
export type MachineSessionReason = typeof MACHINE_SESSION_REASONS[number];
export function machineSessionReasonForOrigin(origin: CopilotInvocationOrigin): MachineSessionReason | null {
  return isAutomaticCopilotOrigin(origin) ? origin as MachineSessionReason : null;
}
export function machineSessionReasonOf(session: {parentId?:string|null;metadata?:Record<string,unknown>} | undefined): MachineSessionReason | null {
  const m=session?.metadata;
  if(m?.['pingPongReviewer']) return 'ping-pong-review';
  if(m?.['planQueueRunId'] || m?.['planQueueRole'] || m?.['spendPurpose']==='plan-queue')return 'plan-queue';
  if(m?.['automationId'] || m?.['spendPurpose']==='automation')return 'automation';
  if(m?.['spendPurpose']==='repo-job')return 'repo-job';
  if(m?.['spawnParentInstanceId'] || m?.['spendPurpose']==='remote-node')return 'node-run';
  return session?.parentId ? 'child' : null;
}

/** The raw grouping key is shared by every worker and verifier for an item. */
export type TrialKeySource = 'plan-queue-item' | 'loop-run' | 'automation' | 'parent' | 'instance';

/** A loop invocation may also pass its key explicitly in spawn options; metadata is the fallback. */
export function resolveTrialKey(session: {
  id?: string;
  parentId?: string | null;
  metadata?: Record<string, unknown>;
}): { key: string | null; source: TrialKeySource | null } {
  const metadata = session.metadata ?? {};
  const candidates: readonly [TrialKeySource, unknown][] = [
    ['plan-queue-item', metadata['planQueueItemId']],
    ['loop-run', metadata['loopRunId']],
    ['automation', metadata['automationId']],
    ['parent', session.parentId],
    ['instance', session.id],
  ];
  for (const [source, value] of candidates) {
    if (typeof value === 'string' && value.length > 0) return { key: value, source };
  }
  return { key: null, source: null };
}
