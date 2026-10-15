import type { Instance } from '../../../shared/types/instance.types';
import { machineSessionReasonOf } from '../../../shared/utils/machine-session';
import { sessionKindOf } from '../../../shared/types/session-kind.types';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory.types';
import { CLAUDE_REVIEWER_MAX_TURNS } from '../../cli/adapters/claude-machine-session-policy';
import { applyProviderSessionDurability } from './provider-session-durability';
export function applyInstanceSpawnPolicy(cliType:string,instance:Pick<Instance,'depth'|'parentId'|'metadata'> & {id?:string}|undefined,options:UnifiedSpawnOptions):UnifiedSpawnOptions {
  const reason=machineSessionReasonOf(instance);
  const m = instance?.metadata;
  const trialKey = [m?.['planQueueItemId'], m?.['loopRunId'], m?.['automationId'], instance?.parentId, instance?.id].find(value => typeof value === 'string' && value.length > 0) as string | undefined;
  const durable=applyProviderSessionDurability(cliType,instance,options);
  return {...durable,trialKey:durable.trialKey ?? trialKey,machineSession:durable.machineSession ?? reason ?? undefined,sessionKind:durable.sessionKind ?? sessionKindOf(reason),
    ...(cliType==='claude' && (reason==='ping-pong-review' || durable.readOnlyReview) ? {readOnlyReview:true,yoloMode:false,maxTurns:durable.maxTurns ?? CLAUDE_REVIEWER_MAX_TURNS} : {})};
}
