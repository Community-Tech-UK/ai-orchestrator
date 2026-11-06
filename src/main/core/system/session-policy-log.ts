import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionKind } from '../../../shared/types/session-kind.types';
import { getLogger } from '../../logging/logger';
const logger=getLogger('SessionPolicyLog');
let lastDay='';let warned=false;
export interface CodexSessionPolicyRecord {
  provider:'codex';threadId:string;sessionKind:SessionKind;level:'off'|'economy'|'full';
  instanceId?:string;
  arm?:'cheaper'|'full'|'off'|'unassigned';armKey?:string;armSource?:string;
  outputLimit:number|null;postTurnCompactPercent:number|null;applied:boolean;
}
export interface ClaudeSessionPolicyRecord {
  provider: 'claude'; sessionId: string; setting: 'parent' | 'sonnet' | 'trial';
  arm: 'same-as-session' | 'sonnet'; applied: boolean;
  armKey?: string; armSource?: string;
  reviewerRuleDelivered: boolean; waitingRuleDelivered: boolean;
}
export interface CodexChildOutcomeRecord {
  provider: 'codex'; recordType: 'child-outcome'; threadId: string;
  instanceId: string; parentId: string; success: boolean | null; exitCode: number | null;
}
export interface CodexReviewOutcomeRecord {
  provider: 'codex'; recordType: 'review-outcome'; threadId: string;
  instanceId: string; verdict: 'APPROVED' | 'CHANGES_REQUESTED';
}
/** Follow-up record: helper threads the Codex adapter has seen under a root thread so far. Counts only grow. */
export interface CodexHelperCountRecord {
  provider: 'codex'; recordType: 'helper-count'; threadId: string;
  instanceId?: string; helperThreads: number;
}
export type SessionPolicyRecord = CodexSessionPolicyRecord | ClaudeSessionPolicyRecord | CodexChildOutcomeRecord | CodexReviewOutcomeRecord | CodexHelperCountRecord;
/** Main-process-only metadata log. No prompts or credentials. */
export function recordSessionPolicy(record:SessionPolicyRecord):void {
  if(!process.versions.electron || (process as NodeJS.Process & {type?:string}).type!=='browser')return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {app}=require('electron') as {app:{getPath(name:string):string}};
    const directory=join(app.getPath('userData'),'session-policy');mkdirSync(directory,{recursive:true});
    const day=new Date().toISOString().slice(0,10);
    if(lastDay!==day){
      lastDay=day;const cutoff=Date.now()-60*24*60*60*1000;
      for(const file of readdirSync(directory))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)&&new Date(file.slice(0,10)).getTime()<cutoff){
        // One undeletable old file (locked, read-only) must not stop the other prunes or today's append.
        try{unlinkSync(join(directory,file));}catch{/* retried on the next day's prune */}
      }
    }
    appendFileSync(join(directory,`${day}.jsonl`),JSON.stringify({at:new Date().toISOString(),...record})+'\n','utf8');
  } catch(error){if(!warned){warned=true;logger.warn('Could not record thread policy',{error:String(error)});}}
}
