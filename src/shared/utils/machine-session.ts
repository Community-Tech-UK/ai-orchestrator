import { isAutomaticCopilotOrigin, type CopilotInvocationOrigin } from '../types/copilot-account.types';
export type MachineSessionReason = 'loop' | 'review' | 'verification' | 'consensus' | 'workflow' | 'automation' | 'failover' | 'internal' | 'child' | 'plan-queue' | 'ping-pong-review' | 'node-run' | 'repo-job';
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
