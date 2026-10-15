import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionKind } from '../../../shared/types/session-kind.types';
import { getLogger } from '../../logging/logger';
const logger=getLogger('SessionPolicyLog');
let lastDay='';let warned=false;
export interface SessionPolicyRecord {
  provider:'codex';threadId:string;sessionKind:SessionKind;level:'off'|'economy'|'full';
  arm?:'control'|'candidate'|'unassigned';armKey?:string;outputLimit:number|null;postTurnCompactPercent:number|null;applied:boolean;
}
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
      for(const file of readdirSync(directory))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)&&new Date(file.slice(0,10)).getTime()<cutoff)unlinkSync(join(directory,file));
    }
    appendFileSync(join(directory,`${day}.jsonl`),JSON.stringify({at:Date.now(),...record,armKey:record.armKey ? createHash('sha256').update(record.armKey).digest('hex') : undefined})+'\n','utf8');
  } catch(error){if(!warned){warned=true;logger.warn('Could not record thread policy',{error:String(error)});}}
}
