import type { MachineSessionReason } from '../utils/machine-session';
export type SessionKind='chat'|'child'|'loop'|'plan-queue'|'automation'|'review';
export function sessionKindOf(reason:MachineSessionReason|null):SessionKind {
  if(reason===null)return 'chat';
  if(reason==='loop'||reason==='plan-queue')return reason;
  if(reason==='automation'||reason==='repo-job')return 'automation';
  if(reason==='child'||reason==='node-run')return 'child';
  return 'review';
}
