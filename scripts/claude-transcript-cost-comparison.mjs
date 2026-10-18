import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

export const COMPARISON_CAVEATS = ['Turns that cross midnight', 'Killed processes',
  "Claude Code's 30-day transcript cleanup", 'Price-table drift (override with --prices <json>)'];
const defaults = {opus:{input:5,output:25},sonnet:{input:3,output:15},haiku:{input:1,output:5},fable:{input:10,output:50}};
function rate(model, prices) {
  if (prices[model]) {
    const value=prices[model];
    if (![value.input,value.output].every(amount=>typeof amount==='number' && Number.isFinite(amount) && amount>=0)) throw new Error(`Invalid price for ${model}`);
    return value;
  }
  if (model.includes('sonnet-5')) return {input:2,output:10};
  if (model.includes('claude-3-opus')) return {input:15,output:75};
  if (model.includes('claude-3-5-haiku')) return {input:0.8,output:4};
  if (model.includes('claude-3-haiku')) return {input:0.25,output:1.25};
  if (model.includes('claude-3-sonnet')) return {input:3,output:15};
  return Object.entries(defaults).find(([family]) => model.includes(family))?.[1];
}
function tokens(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }
function price(usage, rates) {
  const writes = usage.cache_creation;
  const short = tokens(writes?.ephemeral_5m_input_tokens);
  const long = tokens(writes?.ephemeral_1h_input_tokens);
  const unspecified = Math.max(0,tokens(usage.cache_creation_input_tokens)-short-long);
  return ((tokens(usage.input_tokens) + tokens(usage.cache_read_input_tokens)*0.1
    + (short+unspecified)*1.25 + long*2)*rates.input + tokens(usage.output_tokens)*rates.output)/1e6;
}
/** Resolve shared/symlinked projects before walking; never read the same file twice. */
export function compareTranscriptCosts({rows, roots, start, end, prices={}, maxDiffPct=5, byModel=[]}) {
  const files = new Set();
  const directories = new Set();
  function walk(path) {
    let resolved;
    try { resolved=realpathSync(path); } catch { return; }
    const info=statSync(resolved);
    if (info.isFile()) { if (resolved.endsWith('.jsonl')) files.add(resolved); return; }
    if (!info.isDirectory()) return;
    if (directories.has(resolved)) return;
    directories.add(resolved);
    for (const entry of readdirSync(resolved,{withFileTypes:true})) {
      const child=join(resolved,entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) { walk(child); continue; }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.add(realpathSync(child));
    }
  }
  for (const root of roots) if (existsSync(root)) walk(root);
  const seen = new Set();
  const sessions = new Map();
  const unpricedModels = new Set();
  const entry = id => {
    if (!sessions.has(id)) sessions.set(id,{sessionId:id,stored:0,main:0,subagent:0,storedPresent:false,transcriptPresent:false});
    return sessions.get(id);
  };
  for (const row of rows) { const item=entry(row.session_id || row.instance_id); item.stored+=tokens(row.cost); item.storedPresent=true; }
  for (const file of files) {
    const subagent = basename(dirname(file)) === 'subagents';
    const fallbackSession = subagent ? basename(dirname(dirname(file))) : basename(file,'.jsonl');
    for (const line of readFileSync(file,'utf8').split('\n')) {
      let record;
      try { record=JSON.parse(line); } catch { continue; }
      if (record.type !== 'assistant' || !record.message?.usage || record.message.model === '<synthetic>') continue;
      const time=Date.parse(record.timestamp);
      if (!Number.isFinite(time) || time<start || time>=end) continue;
      const messageId=record.message.id;
      if (typeof messageId !== 'string' || seen.has(messageId)) continue;
      seen.add(messageId);
      const item=entry(subagent ? fallbackSession : record.sessionId || fallbackSession);
      item.transcriptPresent=true;
      const rates=rate(record.message.model || '',prices);
      if (!rates) { unpricedModels.add(record.message.model || '(missing)'); continue; }
      item[subagent ? 'subagent' : 'main']+=price(record.message.usage,rates);
    }
  }
  const list=[...sessions.values()].map(item => ({...item,transcript:item.main+item.subagent,
    gap:item.stored-item.main-item.subagent}));
  const stored=list.reduce((sum,item)=>sum+item.stored,0);
  const main=list.reduce((sum,item)=>sum+item.main,0);
  const subagent=list.reduce((sum,item)=>sum+item.subagent,0);
  const transcript=main+subagent;
  const gapPct=transcript>0 ? Math.abs(stored-transcript)/transcript*100 : stored>0 ? null : 0;
  return {stored,transcript,main,subagent,gapPct,
    exceeded:unpricedModels.size>0 || gapPct===null || gapPct>maxDiffPct,
    largestGaps:list.sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap)).slice(0,10),
    storedOnly:list.filter(item=>item.storedPresent&&!item.transcriptPresent).map(item=>item.sessionId),
    transcriptOnly:list.filter(item=>!item.storedPresent&&item.transcriptPresent).map(item=>item.sessionId),
    unpricedModels:[...unpricedModels],byModel,caveats:COMPARISON_CAVEATS};
}
