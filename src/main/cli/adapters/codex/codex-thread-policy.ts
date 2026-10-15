import { createHash } from 'node:crypto';
import type { SessionKind } from '../../../../shared/types/session-kind.types';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { getSettingsManager } from '../../../core/config/settings-manager';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';
const logger = getLogger('CodexThreadPolicy');
export type CodexTrialArm = 'control' | 'candidate' | 'unassigned';
export interface CodexThreadPolicy { level:'off'|'economy'|'full'; config:Record<string,unknown>; outputLimit:number|null; postTurnCompactPercent:number|null }
export function codexTrialArm(key:string|undefined):CodexTrialArm {
  return key ? createHash('sha256').update(key).digest()[0] % 2 === 0 ? 'control' : 'candidate' : 'unassigned';
}
export function resolveCodexThreadPolicy(input:{kind:SessionKind;chatsSetting?:'economy'|'full'|'off'|'trial';harnessWorkSetting?:'off'|'full'|'trial';tuningSetting?:'harness'|'codex';arm?:CodexTrialArm}):CodexThreadPolicy {
  const chat=input.kind==='chat';
  const selected=chat ? input.chatsSetting ?? 'trial' : input.harnessWorkSetting ?? 'trial';
  const level=selected==='trial' ? input.arm==='candidate' ? chat ? 'economy' : 'off' : 'full' : selected;
  const config:Record<string,unknown>=level==='off' ? {'agents.enabled':false} : level==='economy' ? {'agents.default_subagent_reasoning_effort':'medium','agents.max_concurrent_threads_per_session':2} : {};
  const outputLimit=input.tuningSetting==='codex' ? null : chat ? 6000 : 4000;
  const postTurnCompactPercent=input.tuningSetting==='codex' ? null : chat ? 70 : 60;
  if(outputLimit!==null)config['tool_output_token_limit']=outputLimit;
  if(postTurnCompactPercent!==null)config['model_post_turn_compact_threshold_percent']=postTurnCompactPercent;
  return {level,config,outputLimit,postTurnCompactPercent};
}
export function codexThreadPolicyForConfig(config:CodexCliConfig):CodexThreadPolicy {
  let settings:AppSettings;
  try {
    settings=getSettingsManager().getAll();
  }catch(error){
    // Fail closed: resolving trial defaults from empty settings would launch
    // the thread on a machine-session policy the user never configured.
    logger.warn('Codex thread policy could not read settings; failing closed',{ ...errorDiagnostic(error) });
    throw error;
  }
  return resolveCodexThreadPolicy({kind:config.sessionKind ?? 'chat',chatsSetting:settings.codexHelperAgentsChats,harnessWorkSetting:settings.codexHelperAgentsHarnessWork,tuningSetting:settings.codexContextTuning,arm:config.trialArm ?? codexTrialArm(config.trialKey)});
}
