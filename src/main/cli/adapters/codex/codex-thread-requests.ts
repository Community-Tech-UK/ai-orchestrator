import { recordSessionPolicy } from '../../../core/system/session-policy-log';
import { codexTrialArm } from './codex-thread-policy';
import { startThreadWithRetry, type ThreadStartClient } from './thread-start-retry';
import { resumeThreadWithRetry, type ThreadResumeClient } from './thread-resume-retry';
import type { AppServerRequestParams } from './app-server-types';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { CodexThreadPolicy } from './codex-thread-policy';
import { getLogger } from '../../../logging/logger';
const logger=getLogger('CodexThreadPolicy');
function unsupportedConfig(error:unknown):boolean {
  const message=error instanceof Error ? error.message : String(error);
  return /(?:unknown|unrecognized|unsupported|invalid|unexpected)/i.test(message)
    && /config|agents\.|tool_output_token_limit|model_post_turn_compact_threshold_percent/i.test(message);
}
export function buildCodexThreadStartParams(config:CodexCliConfig, input:{cwd:string;sandbox:NonNullable<AppServerRequestParams<'thread/start'>['sandbox']>;approvalPolicy:AppServerRequestParams<'thread/start'>['approvalPolicy']}):AppServerRequestParams<'thread/start'> {
  return {...input,model:config.model||null,serviceName:'ai-orchestrator',ephemeral:config.ephemeral??false,serviceTier:config.fastMode?'priority':null};
}
export async function startCodexThread(client:ThreadStartClient,params:AppServerRequestParams<'thread/start'>,policy:CodexThreadPolicy, config?:CodexCliConfig):ReturnType<typeof startThreadWithRetry> {
  let applied=true;
  let result;
  try {result=await startThreadWithRetry(client,{...params,config:policy.config});}
  catch(error){if(!unsupportedConfig(error))throw error;applied=false;logger.warn('Codex rejected thread policy; retrying without overrides',{level:policy.level});result=await startThreadWithRetry(client,params);}
  logPolicy(result.threadId || result.thread?.id,policy,config,applied);return result;
}
export async function resumeCodexThread(client:ThreadResumeClient,params:AppServerRequestParams<'thread/resume'>,policy:CodexThreadPolicy, config?:CodexCliConfig):ReturnType<typeof resumeThreadWithRetry> {
  let applied=true;
  let result;
  try{result=await resumeThreadWithRetry(client,{...params,config:policy.config});}
  catch(error){if(!unsupportedConfig(error))throw error;applied=false;logger.warn('Codex rejected thread policy; retrying without overrides',{level:policy.level});result=await resumeThreadWithRetry(client,params);}
  logPolicy(result.threadId || result.thread?.id,policy,config,applied);return result;
}

function logPolicy(threadId:string|undefined,policy:CodexThreadPolicy,config:CodexCliConfig|undefined,applied:boolean):void {
  if(!threadId)return;
  recordSessionPolicy({provider:'codex',threadId,sessionKind:config?.sessionKind??'chat',level:policy.level,
    arm:config?.trialArm??codexTrialArm(config?.trialKey),armKey:config?.trialKey,outputLimit:policy.outputLimit,postTurnCompactPercent:policy.postTurnCompactPercent,applied});
}
