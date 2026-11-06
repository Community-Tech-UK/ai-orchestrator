import { asUnknownRecord } from './claude-cli-adapter.types';
import {
  locateClaudeSubagent,
  readClaudeSubagentTranscriptModel,
  type ClaudeSubagentMeta,
  type ClaudeTranscriptLocation,
} from './claude-subagent-meta';
export { claudeTranscriptLocation } from './claude-subagent-meta';
export type ClaudeSubagentModelSource = 'stream' | 'transcript' | 'requested';
export interface ClaudeSubagentUsage {
  toolUseId:string;
  finalContextTokens:number;
  toolUses:number;
  durationMs:number;
  final:boolean;
  /** Final samples only: the model the helper really ran (T6 / K3.8). */
  model?:string;
  modelSource?:ClaudeSubagentModelSource;
  /** Final samples only, from the helper's own meta file (T6 step 3). */
  agentType?:string;
  fork?:boolean;
  depth?:number;
  mode?:'foreground'|'background';
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
/** Where the helper files live: a value, or a function read only when a helper finishes (the session id can change). */
export type ClaudeTranscriptLocationSource=ClaudeTranscriptLocation|(()=>ClaudeTranscriptLocation|null)|null;
/** The cost-log fields for a finished helper; absent details stay absent. */
export function subagentAttributionDetails(sample:ClaudeSubagentUsage) {
  return {
    ...(sample.model ? {model:sample.model} : {}),
    ...(sample.modelSource ? {helperModelSource:sample.modelSource} : {}),
    ...(sample.agentType ? {helperAgentType:sample.agentType} : {}),
    ...(sample.fork!==undefined ? {helperFork:sample.fork} : {}),
    ...(sample.depth!==undefined ? {helperDepth:sample.depth} : {}),
    ...(sample.mode ? {helperMode:sample.mode} : {}),
  };
}
const MAX_TRACKED=1000;
const SAFE_MODEL=/^[A-Za-z0-9._\[\]:-]{1,100}$/;
function remember<V>(map:Map<string,V>,key:string,value:V):void {
  map.delete(key);map.set(key,value);
  while (map.size>MAX_TRACKED) map.delete(map.keys().next().value!);
}
export class ClaudeSubagentUsageTracker {
  private readonly samples=new Map<string,ClaudeSubagentUsage>();
  private readonly finished=new Set<string>();
  private readonly ids=new Map<string,string>();
  private readonly ignoredTasks=new Set<string>();
  /** Helper tool-use id -> model on the helper's own forwarded frames. */
  private readonly models=new Map<string,string>();
  /** Helper tool-use id -> agent id (names the helper's files). */
  private readonly agentIds=new Map<string,string>();
  private location:ClaudeTranscriptLocationSource=null;
  setLocation(location:ClaudeTranscriptLocationSource):void {this.location=location;}
  /** A frame the CLI tagged with the tool call that started its helper; main-thread frames are ignored. */
  observeAssistant(message:unknown):void {
    const raw=asUnknownRecord(message);
    const parent=raw?.['parent_tool_use_id'];
    if (raw?.['type']!=='assistant' || typeof parent!=='string' || !parent) return;
    const model=asUnknownRecord(raw['message'])?.['model'];
    if (typeof model==='string' && model!=='<synthetic>' && SAFE_MODEL.test(model)) remember(this.models,parent,model);
  }
  observe(message:unknown):ClaudeSubagentUsage|null {
    const raw=asUnknownRecord(message);
    if (raw?.['task_type']==='local_bash' && typeof raw['task_id']==='string') {
      this.ignoredTasks.add(raw['task_id']);
      while (this.ignoredTasks.size>10000) this.ignoredTasks.delete(this.ignoredTasks.values().next().value!);
    }
    if (raw?.['subtype']==='task_started' && raw['task_type']==='local_agent'
      && typeof raw['task_id']==='string' && typeof raw['tool_use_id']==='string') {
      this.ids.set(raw['task_id'],raw['tool_use_id']);
      remember(this.agentIds,raw['tool_use_id'],raw['task_id']);
    }
    if (raw?.['task_type']==='local_bash' || (typeof raw?.['task_id']==='string' && this.ignoredTasks.has(raw['task_id']))) return null;
    const sample=parseClaudeSubagentUsage(message);
    if (!sample) return null;
    sample.toolUseId=this.ids.get(sample.toolUseId) ?? sample.toolUseId;
    if (this.finished.has(sample.toolUseId)) return null;
    this.samples.set(sample.toolUseId,sample);
    if (!sample.final) return sample;
    const enriched=this.enrich(sample);
    this.finish(sample.toolUseId);
    return enriched;
  }
  flush():ClaudeSubagentUsage[] {
    const finals=[...this.samples.values()].filter(sample=>!sample.final).map(sample=>this.enrich({...sample,final:true}));
    for (const sample of finals) this.finish(sample.toolUseId);
    return finals;
  }
  /** Add model and start details once, when the helper is done; every read is bounded and fail-soft. */
  private enrich(sample:ClaudeSubagentUsage):ClaudeSubagentUsage {
    const out:ClaudeSubagentUsage={...sample};
    const streamModel=this.models.get(sample.toolUseId);
    let agentId=this.agentIds.get(sample.toolUseId);
    let meta:ClaudeSubagentMeta|undefined;
    let transcriptModel:string|undefined;
    try {
      const location=typeof this.location==='function' ? this.location() : this.location;
      if (location) {
        const found=(agentId ? locateClaudeSubagent(location,{agentId}) : undefined)
          ?? locateClaudeSubagent(location,{toolUseId:sample.toolUseId});
        if (found) {
          agentId=found.agentId;meta=found.meta;
          if (!streamModel) transcriptModel=readClaudeSubagentTranscriptModel(location,{agentId});
        }
      }
    } catch { /* telemetry must never break the turn */ }
    const model=streamModel ?? transcriptModel ?? meta?.requestedModel;
    if (model) {
      out.model=model;
      out.modelSource=streamModel ? 'stream' : transcriptModel ? 'transcript' : 'requested';
    }
    if (meta) {
      if (meta.agentType) out.agentType=meta.agentType;
      if (meta.isFork!==undefined) out.fork=meta.isFork;
      if (meta.spawnDepth!==undefined) out.depth=meta.spawnDepth;
      if (meta.requestShape) out.mode=meta.requestShape;
    }
    return out;
  }
  private finish(id:string):void {
    this.samples.delete(id);this.finished.add(id);this.models.delete(id);this.agentIds.delete(id);
    for (const [task,tool] of this.ids) if (tool===id) {this.finished.add(task);this.ids.delete(task);}
    while (this.finished.size>10000) this.finished.delete(this.finished.values().next().value!);
  }
}
interface Host {emit(event:string,...args:unknown[]):boolean}
const trackers=new WeakMap<Host,ClaudeSubagentUsageTracker>();
function tracker(host:Host):ClaudeSubagentUsageTracker {
  let value=trackers.get(host);if (!value) {value=new ClaudeSubagentUsageTracker();trackers.set(host,value);}return value;
}
/** `location` names where the CLI keeps this session's helper files; pass it with every system frame (the session id can change). */
export function observeClaudeSubagentUsage(host:Host,message:unknown,location?:ClaudeTranscriptLocationSource):void {
  const state=tracker(host);
  if (location!==undefined) state.setLocation(location);
  const sample=state.observe(message);if (sample) host.emit('subagent_usage',sample);
}
/** Call for every assistant frame; only frames tagged with a helper's tool call are kept. */
export function observeClaudeSubagentModel(host:Host,message:unknown):void {
  tracker(host).observeAssistant(message);
}
export function flushClaudeSubagentUsage(host:Host):void {
  for (const sample of tracker(host).flush()) host.emit('subagent_usage',sample);
}
