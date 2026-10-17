import type { Instance } from '../../../shared/types/instance.types';
import { machineSessionReasonOf } from '../../../shared/utils/machine-session';
import { sessionKindOf } from '../../../shared/types/session-kind.types';
import { normalizeOpenCodeAdditionalDirectories } from '../../../shared/utils/opencode-additional-directories';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory.types';
import { CLAUDE_REVIEWER_MAX_TURNS } from '../../cli/adapters/claude-machine-session-policy';
import { applyProviderSessionDurability } from './provider-session-durability';
import { createProviderPromptCheckpoint } from './instance-provider-prompt-checkpoint';
import { requireOpenCodeNativeForkPlacement } from './opencode-native-fork-placement';
export function applyInstanceSpawnPolicy(cliType:string,instance:Pick<Instance,'depth'|'parentId'|'metadata'|'additionalDirectories'> & {id?:string}|undefined,options:UnifiedSpawnOptions):UnifiedSpawnOptions {
  const reason=machineSessionReasonOf(instance);
  const m = instance?.metadata;
  const trialKey = [m?.['planQueueItemId'], m?.['loopRunId'], m?.['automationId'], instance?.parentId, instance?.id].find(value => typeof value === 'string' && value.length > 0) as string | undefined;
  const durable=applyProviderSessionDurability(cliType,instance,options);
  const nodePlacement = cliType === 'opencode' && typeof m?.['openCodeForkSessionId'] === 'string' && m['openCodeForkSessionId'].trim()
    ? requireOpenCodeNativeForkPlacement(durable.nodePlacement) : durable.nodePlacement;
  return {...durable,nodePlacement,...(cliType === 'opencode' && instance?.id ? { beforeProviderPrompt: createProviderPromptCheckpoint(instance.id) } : {}),additionalDirectories:normalizeOpenCodeAdditionalDirectories(instance?.additionalDirectories ?? options.additionalDirectories,options.modelRuntimeTarget?.kind === 'local-model' ? 'local-model' : cliType),trialKey:durable.trialKey ?? trialKey,machineSession:durable.machineSession ?? reason ?? undefined,sessionKind:durable.sessionKind ?? sessionKindOf(reason),
    ...(cliType==='claude' && (reason==='ping-pong-review' || durable.readOnlyReview) ? {readOnlyReview:true,yoloMode:false,maxTurns:durable.maxTurns ?? CLAUDE_REVIEWER_MAX_TURNS} : {})};
}
