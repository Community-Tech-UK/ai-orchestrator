import { asUnknownRecord } from './claude-cli-adapter.types';
export interface ClaudeSubagentUsage {
  toolUseId:string;
  finalContextTokens:number;
  toolUses:number;
  durationMs:number;
  final:boolean;
}
/** Last context size is telemetry, not cumulative spend. No model-written text is retained. */
export function parseClaudeSubagentUsage(message:unknown):ClaudeSubagentUsage|null {
  const record=asUnknownRecord(message);
  const kind=record?.['subtype'] ?? record?.['type'];
  if (kind!=='task_progress' && kind!=='task_notification') return null;
  const usage=asUnknownRecord(record?.['usage']);
  const id=record?.['tool_use_id'] ?? record?.['toolUseId'] ?? record?.['task_id'];
  if (!usage || typeof id!=='string' || !id) return null;
  const value=(snake:string,camel:string):number|undefined=>{
    const count=usage[snake] ?? usage[camel];
    return typeof count==='number' && Number.isFinite(count) && count>=0 ? count : undefined;
  };
  const tokens=value('total_tokens','totalTokens'), tools=value('tool_uses','toolUses'), duration=value('duration_ms','durationMs');
  if (tokens===undefined || tools===undefined || duration===undefined) return null;
  return {toolUseId:id,finalContextTokens:tokens,toolUses:tools,durationMs:duration,final:kind==='task_notification'};
}
export class ClaudeSubagentUsageTracker {
  private readonly samples=new Map<string,ClaudeSubagentUsage>();
  private readonly finished=new Set<string>();
  private readonly ids=new Map<string,string>();
  private readonly ignoredTasks=new Set<string>();
  observe(message:unknown):ClaudeSubagentUsage|null {
    const raw=asUnknownRecord(message);
    if (raw?.['task_type']==='local_bash' && typeof raw['task_id']==='string') {
      this.ignoredTasks.add(raw['task_id']);
      while (this.ignoredTasks.size>10000) this.ignoredTasks.delete(this.ignoredTasks.values().next().value!);
    }
    if (raw?.['subtype']==='task_started' && raw['task_type']==='local_agent'
      && typeof raw['task_id']==='string' && typeof raw['tool_use_id']==='string') {
      this.ids.set(raw['task_id'],raw['tool_use_id']);
    }
    if (raw?.['task_type']==='local_bash' || (typeof raw?.['task_id']==='string' && this.ignoredTasks.has(raw['task_id']))) return null;
    const sample=parseClaudeSubagentUsage(message);
    if (!sample) return null;
    sample.toolUseId=this.ids.get(sample.toolUseId) ?? sample.toolUseId;
    if (this.finished.has(sample.toolUseId)) return null;
    this.samples.set(sample.toolUseId,sample);
    if (sample.final) this.finish(sample.toolUseId);
    return sample;
  }
  flush():ClaudeSubagentUsage[] {
    const finals=[...this.samples.values()].filter(sample=>!sample.final).map(sample=>({...sample,final:true}));
    for (const sample of finals) this.finish(sample.toolUseId);
    return finals;
  }
  private finish(id:string):void {
    this.samples.delete(id);this.finished.add(id);
    for (const [task,tool] of this.ids) if (tool===id) {this.finished.add(task);this.ids.delete(task);}
    while (this.finished.size>10000) this.finished.delete(this.finished.values().next().value!);
  }
}
interface Host {emit(event:string,...args:unknown[]):boolean}
const trackers=new WeakMap<Host,ClaudeSubagentUsageTracker>();
function tracker(host:Host):ClaudeSubagentUsageTracker {
  let value=trackers.get(host);if (!value) {value=new ClaudeSubagentUsageTracker();trackers.set(host,value);}return value;
}
export function observeClaudeSubagentUsage(host:Host,message:unknown):void {
  const sample=tracker(host).observe(message);if (sample) host.emit('subagent_usage',sample);
}
export function flushClaudeSubagentUsage(host:Host):void {
  for (const sample of tracker(host).flush()) host.emit('subagent_usage',sample);
}
