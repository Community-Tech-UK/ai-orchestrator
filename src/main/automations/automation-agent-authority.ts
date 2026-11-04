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
  const model = verifiedAutomationModel(provider, action.model || (provider === caller.provider ? caller.currentModel : undefined));
  if (!model || !callerModel || TIERS[model.tier] > TIERS[callerModel.tier]) return refuse('model (the effective model tier is unknown or higher)');
  if (provider !== 'claude' && provider !== 'codex') return refuse('authority (this runtime cannot enforce the limits)');
  const next: AutomationAction = { ...action, provider, model: model.id, reasoningEffort, yoloMode: action.yoloMode ?? false,
    executionAuthority: Object.freeze({ provider, model: model.id, modelTier: model.tier, reasoningEffort, yoloMode: action.yoloMode ?? false }) };
  assertAutomationLoopShape(next);
  boundAutomationSpawnOptions(next.executionAuthority, provider, next);
  return next;
}
