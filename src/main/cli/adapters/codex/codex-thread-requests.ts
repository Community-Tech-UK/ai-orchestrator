import { recordSessionPolicy } from '../../../core/system/session-policy-log';
import { startThreadWithRetry, type ThreadStartClient } from './thread-start-retry';
import { resumeThreadWithRetry, type ThreadResumeClient } from './thread-resume-retry';
import type { AppServerRequestParams } from './app-server-types';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { CodexThreadPolicy } from './codex-thread-policy';
import { getLogger } from '../../../logging/logger';
const logger=getLogger('CodexThreadPolicy');
/** Codex may name an override by its full key or, as serde does for nested fields, by its last part only. */
function namesAnOverride(message:string,policy:CodexThreadPolicy):boolean {
  return Object.keys(policy.config).flatMap(key=>[key,key.slice(key.lastIndexOf('.')+1)])
    .some(name=>new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`).test(message));
}
function unsupportedConfig(error:unknown,policy:CodexThreadPolicy):boolean {
  const message=error instanceof Error ? error.message : String(error);
  return /(?:unknown|unrecognized|unsupported|invalid|unexpected)/i.test(message)&&(/config/i.test(message)||namesAnOverride(message,policy));
}
export function buildCodexThreadStartParams(config:CodexCliConfig, input:{cwd:string;sandbox:NonNullable<AppServerRequestParams<'thread/start'>['sandbox']>;approvalPolicy:AppServerRequestParams<'thread/start'>['approvalPolicy']}):AppServerRequestParams<'thread/start'> {
  return {...input,model:config.model||null,serviceName:'ai-orchestrator',ephemeral:config.ephemeral??false,serviceTier:config.fastMode?'priority':null};
}
export async function startCodexThread(client:ThreadStartClient,params:AppServerRequestParams<'thread/start'>,policy:CodexThreadPolicy, config?:CodexCliConfig):ReturnType<typeof startThreadWithRetry> {
  let applied=true;
  let result;
  try {result=await startThreadWithRetry(client,{...params,config:policy.config});}
  catch(error){if(!unsupportedConfig(error,policy))throw error;applied=false;logger.warn('Codex rejected thread policy; retrying without overrides',{level:policy.level});result=await startThreadWithRetry(client,params);}
  logPolicy(result.threadId || result.thread?.id,policy,config,applied,'start');return result;
}
export async function resumeCodexThread(client:ThreadResumeClient,params:AppServerRequestParams<'thread/resume'>,policy:CodexThreadPolicy, config?:CodexCliConfig):ReturnType<typeof resumeThreadWithRetry> {
  let applied=true;
  let result;
  try{result=await resumeThreadWithRetry(client,{...params,config:policy.config});}
  catch(error){if(!unsupportedConfig(error,policy))throw error;applied=false;logger.warn('Codex rejected thread policy; retrying without overrides',{level:policy.level});result=await resumeThreadWithRetry(client,params);}
  logPolicy(result.threadId || result.thread?.id,policy,config,applied,'resume');return result;
}

function logPolicy(threadId:string|undefined,policy:CodexThreadPolicy,config:CodexCliConfig|undefined,applied:boolean,operation:'start'|'resume'):void {
  // The turn adapter names required skills only while the catalog is really off, so this follows the thread that actually started.
  if(config)config.skillCatalogOmitted=applied&&policy.config['skills.include_instructions']===false;
  if(!threadId)return;
  recordSessionPolicy({provider:'codex',threadId,sessionKind:config?.sessionKind??'chat',level:policy.level,operation,
    arm:policy.arm,armKey:policy.armKey??config?.trialKey,armSource:policy.armSource??config?.trialKeySource,
    instanceId:config?.harnessInstanceId,outputLimit:policy.outputLimit,postTurnCompactPercent:policy.postTurnCompactPercent,applied,
    configKeys:applied?Object.keys(policy.config).sort():[],
    // A rejected override set drops every key, the 1,500-token cap included, so the thread runs on Codex's own catalog.
    // An accepted set records what it asked for: Codex 0.167.0 accepts unknown keys silently and its reply does not echo the settings in force.
    ...(policy.catalog?{catalog:applied?policy.catalog:'native'}:{}),
    ...(policy.checkerArm?{checkerArm:policy.checkerArm}:{})});
}
