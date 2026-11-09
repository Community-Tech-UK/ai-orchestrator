import type { AutomationAction, AutomationReasoningEffort } from '../../shared/types/automation.types';
import { getDefaultReasoningEffort } from '../../shared/types/provider.types';
import { boundAutomationSpawnOptions, verifiedAutomationModel } from './automation-execution-authority';
import { assertAutomationLoopShape } from './automation-loop-authority';

export interface AutomationCallerAuthority {
  provider: string;
  currentModel?: string;
  reasoningEffort?: AutomationReasoningEffort;
  yoloMode: boolean;
}
const EFFORTS: AutomationReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'workflow'];
const TIERS = { fast: 0, balanced: 1, powerful: 2 };

/** Rebuild every executable dimension from the authenticated caller, never an incoming snapshot. */
export function enforceAutomationAuthority(action: AutomationAction, caller: AutomationCallerAuthority | undefined): AutomationAction {
  const refuse = (field: string): never => {
    throw new Error(`Cannot raise scheduled job ${field} above the calling session. Use this session's model, effort and auto-approval limits, or ask the user to change the job in the Automations form.`);
  };
  if (!caller) return refuse('authority (the calling session could not be resolved)');
  if (action.yoloMode && !caller.yoloMode) refuse('auto-approval');
  const ceilingEffort = caller.reasoningEffort ?? getDefaultReasoningEffort(caller.provider, caller.currentModel);
  if (!ceilingEffort || !EFFORTS.includes(ceilingEffort)) refuse('effort (the effective effort is unknown)');
  const requestedEffort = action.reasoningEffort ?? ceilingEffort!;
  const reasoningEffort = EFFORTS.indexOf(requestedEffort) > EFFORTS.indexOf('max') ? 'max' : requestedEffort;
  if (!EFFORTS.includes(reasoningEffort) || EFFORTS.indexOf(reasoningEffort) > EFFORTS.indexOf(ceilingEffort!)) refuse('effort');
  const provider = action.provider && action.provider !== 'auto' ? action.provider : caller.provider;
  const callerModel = verifiedAutomationModel(caller.provider, caller.currentModel);
  const requestedModel = action.model || (provider === caller.provider ? caller.currentModel : undefined);
  const model = verifiedAutomationModel(provider, requestedModel);
  if (!callerModel) return refuse(`model (the tier of this session's model "${caller.currentModel ?? 'default'}" is not in Harness's model list)`);
  if (!model) return refuse(`model (the tier of the job's model "${requestedModel ?? 'default'}" is not in Harness's model list)`);
  if (TIERS[model.tier] > TIERS[callerModel.tier]) return refuse('model');
  if (provider !== 'claude' && provider !== 'codex') return refuse('authority (this runtime cannot enforce the limits)');
  // Like model and effort, an unset auto-approval inherits the caller's own value.
  const yoloMode = action.yoloMode ?? caller.yoloMode;
  const next: AutomationAction = { ...action, provider, model: model.id, reasoningEffort, yoloMode,
    executionAuthority: Object.freeze({ provider, model: model.id, modelTier: model.tier, reasoningEffort, yoloMode }) };
  assertAutomationLoopShape(next);
  boundAutomationSpawnOptions(next.executionAuthority, provider, next);
  return next;
}
