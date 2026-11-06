import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import type { runReport } from '../codex-helper-trial-report.mjs';
import { costRow, writeCostDir, writeLoopDb, type QueueItemRow } from './codex-helper-trial-fixtures';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(sample = false) {
const repo = resolve('.');
const dir = mkdtempSync(join(tmpdir(), 'review-outcome-boundary-')); dirs.push(dir);
const policy = join(dir, 'policy'); mkdirSync(policy);
const base = Date.parse('2026-09-01T00:00:00Z');
const entries: Record<string, unknown>[] = []; const rows: string[] = [];
for (const arm of ['off', 'full']) for (const availability of ['complete', 'no-usage', 'missing']) {
  const id = `review-${arm}-${availability}`; const rollout = join(dir, `${id}.jsonl`);
  const records: Record<string, unknown>[] = [{ type:'event_msg', timestamp:base, payload:{type:'task_started'} }];
  if (availability === 'complete') records.push({type:'token_usage_record', timestamp:base+10,
    payload:{thread_token_usage:{input_tokens:100,cached_input_tokens:0,output_tokens:1}}});
  records.push({type:'event_msg',timestamp:base+90,payload:{type:'task_complete'}});
  if (availability !== 'missing') writeFileSync(rollout, records.map(record => JSON.stringify(record)).join('\n'));
  rows.push(`('${id}','${rollout}')`);
  entries.push({at:new Date(base).toISOString(),provider:'codex',threadId:id,instanceId:`instance-${id}`,
    sessionKind:'review',arm,level:arm,armKey:`key-${id}`,armSource:'parent',applied:true});
}
const items: QueueItemRow[]=[]; const costRows: Record<string, unknown>[]=[];
for(const [kind,arms,count,turns] of (sample ? [['chat',['cheaper','full'],40,3],['plan-queue',['off','full'],20,1]] as const : [])) for(const arm of arms) for(let i=0;i<count;i++){
 const id=`${kind}-${arm}-${i}`,rollout=join(dir,`${id}.jsonl`); const records: Record<string, unknown>[]=[];
 for(let turn=0;turn<turns;turn++){const at=base+turn*100;records.push({type:'event_msg',timestamp:at,payload:{type:'task_started'}},{type:'token_usage_record',timestamp:at+10,payload:{thread_token_usage:{input_tokens:(arm==='full'?100:kind==='chat'?80:75)*(turn+1),cached_input_tokens:0,output_tokens:turn+1}}},{type:'event_msg',timestamp:at+90,payload:{type:'task_complete'}});}
 if(kind!=='plan-queue'){writeFileSync(rollout,records.map(record => JSON.stringify(record)).join('\n'));rows.push(`('${id}','${rollout}')`);}entries.push({at:new Date(base).toISOString(),provider:'codex',threadId:id,instanceId:`instance-${id}`,sessionKind:kind,arm,level:arm==='cheaper'?'economy':arm,armKey:id,armSource:'parent',applied:true});if(kind==='plan-queue'){items.push({id,state:'landed',round:1,createdAt:base,updatedAt:base+60000});costRows.push(costRow({instanceId:`instance-${id}`,input:arm==='full'?100:75,cacheRead:0,ts:base+50}));}
}
writeFileSync(join(policy,'policy.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n'));
const state = join(dir,'state.sqlite'); const queue = join(dir,'queue.sqlite');
execFileSync('sqlite3',[state,`CREATE TABLE threads(id TEXT,rollout_path TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT); INSERT INTO threads VALUES ${rows.join(',')};`]);
writeLoopDb(queue,items); const costDir=join(dir,'cost-attribution'); writeCostDir(costDir,costRows);
function run(json: boolean): unknown {
 const args=[join(repo,'scripts/codex-helper-trial-report.mjs'),'--since','2026-09-01','--until','2026-09-23',
 '--policy-dir',policy,'--state-db',state,'--sessions-dir',dir,'--loop-db',queue,'--cost-dir',costDir,'--rlm-db',join(dir,'absent.sqlite'),...(json?['--json']:[])];
 const result=spawnSync(process.execPath,args,{cwd:repo,encoding:'utf8',env:{...process.env,AIO_CODEX_HELPERS_SQLITE_DRIVER:'cli'}});
 const stem=join(dir,json?'report-json':'report-text');
 writeFileSync(`${stem}.stdout`,result.stdout??''); writeFileSync(`${stem}.stderr`,result.stderr??'');
 writeFileSync(`${stem}.receipt.json`,JSON.stringify({command:[process.execPath,...args],status:result.status,signal:result.signal,error:result.error?.message},null,2));
 assert.equal(result.signal,null); assert.equal(result.status,0,result.stderr);
 return json?JSON.parse(result.stdout):result.stdout;
}
const report=run(true) as Awaited<ReturnType<typeof runReport>> & { verdict: { harnessWork: string; chats: string; notes: string[] } }; const text=run(false) as string;
return { report, text };
}
it.each([false,true])('keeps review verdict coverage unknown independently of usage; full sample=%s', sample => {
const {report,text}=fixture(sample);
for(const arm of ['off','full']) {
 const row=report.kindTable.review[arm];
 expect(row).toMatchObject({threads:1,turns:1,meanInputPerTurn:100,completed:1,notCompleted:0});
 expect(row.reviewVerdicts).toEqual({returned:null,notReturned:null,unknown:3,reason:'Authoritative review verdict receipts are not recorded in these sources.'});
}
expect(text).toMatch(/Review verdict[^\n]*unknown/i);
expect(text).toContain('completed turns measure transport completion');
if(sample){expect(report.verdict.harnessWork).toBe('off-justified');expect(report.verdict.chats).toBe('cheaper-justified');expect(report.verdict.notes.join(' ')).toContain('Review verdict outcomes are unknown');expect(report.verdict.notes.join(' ')).not.toContain('Kind "review" completes');}
});
