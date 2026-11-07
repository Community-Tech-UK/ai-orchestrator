import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionKind } from '../../../shared/types/session-kind.types';
import { getLogger } from '../../logging/logger';
const logger=getLogger('SessionPolicyLog');
let lastDay='';let warned=false;
export interface CodexSessionPolicyRecord {
  provider:'codex';threadId:string;sessionKind:SessionKind;level:'off'|'economy'|'full';
  instanceId?:string;
  /** Absent in older persisted rows; only a recorded start proves lifetime coverage in a report window. */
  operation?:'start'|'resume';
  arm?:'cheaper'|'full'|'off'|'unassigned';armKey?:string;armSource?:string;
  outputLimit:number|null;postTurnCompactPercent:number|null;
  /** The overrides were sent and Codex did not reject them. Codex accepts keys it does not know and never says which it honoured, so this is not proof the limits took effect. */
  applied:boolean;
  /** Names of the per-thread overrides sent (empty when Codex rejected them), so each trial arm's exact settings are on record. Names only, never values. */
  configKeys?:string[];
  /** Skills catalog the overrides asked for ('native' when none were accepted), not one Codex confirmed. Also the checker-catalog trial arm for plan-queue checkers (Oct-2 Phase D Steps 2.1 and 3). */
  catalog?:'native'|'capped'|'omitted';checkerArm?:'control'|'candidate'|'unassigned';
  /** Helper trial exposure, independent of context/output tuning compatibility. */
  helperPolicyApplied?:boolean;
  /** Override keys Codex rejected (a retry drops only these), the window in force and whether a large plan was exempt from the 272K cap. */
  rejectedKeys?:string[];contextWindow?:number;largeDocumentExempt?:boolean;
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
/**
 * One Codex round: how much of it the root thread spent and how much the helper
 * threads spent (Oct-2 Phase D Step 2.3), so "helpers cost X%" is measured.
 * Receipts for a finished round can arrive late (child rollouts, trailing usage),
 * so a round may be written again with a higher `revision`; readers keep the
 * highest revision per thread and turn (`latestTurnShares`).
 */
export interface SessionTurnShareRecord {
  event:'turn-share';provider:'codex';threadId:string;turnId:string;revision:number;sessionKind:SessionKind;instanceId?:string;
  arm?:'cheaper'|'full'|'off'|'unassigned';armKey?:string;armSource?:string;
  rootTokens:number;helperTokens:number;totalTokens:number;helperShare:number;
  wrapUpDelivered:boolean;
  /** Harness asked for the round to be stopped (the typed stop error follows once the turn ends). */
  stopRequested:boolean;
}
/**
 * Codex's own credit estimate for one root thread, read when the thread ends (Step 11.1).
 * The figure is cumulative for the thread, so readers keep the latest row per thread.
 */
export interface SessionThreadCreditsRecord {
  event:'thread-credits';provider:'codex';threadId:string;sessionKind:SessionKind;instanceId?:string;
  arm?:'cheaper'|'full'|'off'|'unassigned';armKey?:string;armSource?:string;
  estimatedUsageCreditsMicros:number;estimatedUsageUsdMicros:number|null;totalTokens:number|null;
  groups:{model:string|null;reasoningEffort:string|null;speed:string|null;totalTokens:number|null;estimatedUsageCreditsMicros:number}[];
}
type SessionPolicyEvent={event?:string}&Record<string,unknown>;
function policyDirectory():string|null {
  // Tests and headless tools point the log at a scratch directory, as AIO_COST_ATTRIBUTION_DIR does.
  const explicit=process.env['AIO_SESSION_POLICY_DIR']?.trim();
  if(explicit)return explicit;
  if(!process.versions.electron || (process as NodeJS.Process & {type?:string}).type!=='browser')return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {app}=require('electron') as {app:{getPath(name:string):string}};
  return join(app.getPath('userData'),'session-policy');
}
function append(record:Record<string,unknown>):void {
  try {
    const directory=policyDirectory();if(!directory)return;
    mkdirSync(directory,{recursive:true});
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
/** Main-process-only metadata log. No prompts or credentials. */
export function recordSessionPolicy(record:SessionPolicyRecord):void { append({...record}); }
export function recordSessionTurnShare(record:SessionTurnShareRecord):void { append({...record}); }
export function recordSessionThreadCredits(record:SessionThreadCreditsRecord):void { append({...record}); }
interface CachedPolicyFile{size:number;mtimeMs:number;rows:(SessionPolicyEvent&{at:number})[]}
const fileCache=new Map<string,CachedPolicyFile>();
/** Rows of one event kind written since `sinceMs` (day files are cached until they change; bad lines are skipped). */
export function readSessionPolicyEvents<T extends {event:string}>(event:T['event'],sinceMs:number,directory=policyDirectory()):(T&{at:number})[] {
  const rows:(T&{at:number})[]=[];
  if(!directory||!existsSync(directory))return rows;
  try {
    for(const name of readdirSync(directory).filter(name=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))){
      if(Date.parse(name.slice(0,10)+'T00:00:00Z')+86_400_000<=sinceMs)continue;
      const file=join(directory,name),stats=statSync(file);
      let cached=fileCache.get(file);
      if(!cached||cached.size!==stats.size||cached.mtimeMs!==stats.mtimeMs){
        const parsed:CachedPolicyFile['rows']=[];
        for(const line of readFileSync(file,'utf8').split('\n')){
          try{
            // Rows carry an ISO timestamp (older ones a number); readers work in milliseconds.
            const row=JSON.parse(line) as SessionPolicyEvent&{at:number|string};
            const at=typeof row?.at==='number' ? row.at : typeof row?.at==='string' ? Date.parse(row.at) : Number.NaN;
            if(row&&typeof row.event==='string'&&Number.isFinite(at))parsed.push({...row,at});
          }catch{/* partial append */}
        }
        cached={size:stats.size,mtimeMs:stats.mtimeMs,rows:parsed};fileCache.set(file,cached);
      }
      for(const row of cached.rows)if(row.event===event&&row.at>=sinceMs)rows.push(row as T&{at:number});
    }
  } catch { /* a transient read failure leaves what was readable */ }
  return rows;
}
/** The highest revision per thread and turn (ties go to the later write). */
export function latestTurnShares<T extends Pick<SessionTurnShareRecord,'threadId'|'turnId'|'revision'>&{at:number}>(rows:readonly T[]):T[] {
  const latest=new Map<string,T>();
  for(const row of rows){
    const key=`${row.threadId}\u0000${row.turnId}`,kept=latest.get(key);
    if(!kept||row.revision>kept.revision||(row.revision===kept.revision&&row.at>=kept.at))latest.set(key,row);
  }
  return [...latest.values()];
}
/** The latest cumulative reading per thread. */
export function latestThreadCredits<T extends Pick<SessionThreadCreditsRecord,'threadId'>&{at:number}>(rows:readonly T[]):T[] {
  const latest=new Map<string,T>();
  for(const row of rows){const kept=latest.get(row.threadId);if(!kept||row.at>=kept.at)latest.set(row.threadId,row);}
  return [...latest.values()];
}
