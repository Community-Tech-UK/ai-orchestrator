import { boundAutomationSpawnOptions, refuseAutomationAuthority } from '../../automations/automation-execution-authority';
import type { Instance } from '../../../shared/types/instance.types';
import { machineSessionReasonOf, resolveTrialKey } from '../../../shared/utils/machine-session';
import { sessionKindOf } from '../../../shared/types/session-kind.types';
import { normalizeOpenCodeAdditionalDirectories } from '../../../shared/utils/opencode-additional-directories';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory.types';
import { CLAUDE_REVIEWER_MAX_TURNS } from '../../cli/adapters/claude-machine-session-policy';
import { applyProviderSessionDurability } from './provider-session-durability';
import { createProviderPromptCheckpoint } from './instance-provider-prompt-checkpoint';
import { requireOpenCodeNativeForkPlacement } from './opencode-native-fork-placement';
import { resolveContextCeilingTokens } from '../../cli/adapters/context-ceiling';
import { resolveClaudeBashOutputMaxChars } from '../../cli/adapters/claude-output-caps';
export function applyInstanceSpawnPolicy(cliType:string,instance:Pick<Instance,'depth'|'parentId'|'metadata'|'additionalDirectories'|'automationAuthority'> & {id?:string;executionLocation?:Instance['executionLocation']}|undefined,options:UnifiedSpawnOptions,livePermissionPromptsEnabled=false):UnifiedSpawnOptions {
  if (instance?.automationAuthority && instance.executionLocation?.type === 'remote') refuseAutomationAuthority('remote execution cannot enforce the saved limits');
  options = boundAutomationSpawnOptions(instance?.automationAuthority, cliType, options);
  const m = instance?.metadata;
  const baseReason=machineSessionReasonOf(instance);
  const reason=(baseReason === null || baseReason === 'child') && m?.['loopRunId'] ? 'loop' : baseReason;
  const kind = options.sessionKind ?? sessionKindOf(options.machineSession ?? reason);
  // Only ownership metadata supplies a job ID; trial keys may contain arbitrary grouping text.
  const jobKeys = kind === 'plan-queue' ? ['planQueueItemId', 'planQueueRunId']
    : kind === 'automation' ? ['automationRunId', 'repoJobId']
    : kind === 'loop' ? ['loopRunId'] : [];
  const jobId = jobKeys.map(key => m?.[key]).find(value => typeof value === 'string' && value.length > 0) as string | undefined;
  const resolvedTrial = resolveTrialKey(instance ?? {});
  const trialKey = options.trialKey ?? resolvedTrial.key ?? undefined;
  const trialKeySource = options.trialKeySource ?? (trialKey === resolvedTrial.key ? resolvedTrial.source ?? undefined : undefined);
  const durable=applyProviderSessionDurability(cliType,instance,options);
  const machineSession = durable.machineSession ?? reason ?? undefined;
  const nodePlacement = cliType === 'opencode' && typeof m?.['openCodeForkSessionId'] === 'string' && m['openCodeForkSessionId'].trim()
    ? requireOpenCodeNativeForkPlacement(durable.nodePlacement) : durable.nodePlacement;
  return {...durable,nodePlacement,instanceId:durable.instanceId ?? instance?.id,jobId:durable.jobId ?? jobId,...(cliType === 'opencode' && instance?.id ? { beforeProviderPrompt: createProviderPromptCheckpoint(instance.id) } : {}),additionalDirectories:normalizeOpenCodeAdditionalDirectories(instance?.additionalDirectories ?? options.additionalDirectories,options.modelRuntimeTarget?.kind === 'local-model' ? 'local-model' : cliType),trialKey:durable.trialKey ?? trialKey,trialKeySource,machineSession,livePermissionPrompts:cliType === 'claude' && livePermissionPromptsEnabled && !machineSession,sessionKind:kind,
    queueRole:durable.queueRole ?? (typeof m?.['planQueueRole'] === 'string' ? m['planQueueRole'] : undefined),
    ...(cliType === 'claude' ? {
      contextCeilingTokens: durable.contextCeilingTokens ?? resolveContextCeilingTokens(Boolean(reason)),
      bashOutputMaxChars: durable.bashOutputMaxChars ?? resolveClaudeBashOutputMaxChars(),
    } : {}),
    ...(cliType==='claude' && (reason==='ping-pong-review' || durable.readOnlyReview) ? {readOnlyReview:true,yoloMode:false,maxTurns:durable.maxTurns ?? CLAUDE_REVIEWER_MAX_TURNS} : {})};
}
