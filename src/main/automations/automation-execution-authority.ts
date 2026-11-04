import type { AutomationAction, AutomationDestination, AutomationExecutionAuthority } from '../../shared/types/automation.types';
import { getModelsForProvider, isModelTier, normalizeModelAliasForProvider, REASONING_EFFORTS, resolveModelForTier } from '../../shared/types/provider.types';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory.types';

const TIERS = { fast: 0, balanced: 1, powerful: 2 };

export function refuseAutomationAuthority(detail: string): never {
  throw new Error(`Cannot execute automation within approved authority: ${detail}. Choose a supported local provider/model/effort and a fresh session, or ask James to use the Automations form.`);
}

export function verifiedAutomationModel(provider: string, model?: string) {
  const alias = normalizeModelAliasForProvider(provider, model);
  const id = alias && isModelTier(alias) ? resolveModelForTier(alias, provider) : alias;
  return getModelsForProvider(provider).find(entry => entry.id === id);
}

/** Validate the snapshot itself as well as the final resolved native options.
 * A catalogue/default change must never silently raise the saved tier. */
export function boundAutomationSpawnOptions(
  authority: Readonly<AutomationExecutionAuthority> | undefined,
  provider: string,
  options: UnifiedSpawnOptions,
): UnifiedSpawnOptions {
  if (!authority) return options;
  const efforts = provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max']
    : provider === 'codex' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : [];
  if (provider !== authority.provider) refuseAutomationAuthority('the approved provider is unavailable; automatic provider fallback is not authorized');
  const approved = verifiedAutomationModel(provider, authority.model);
  const actual = verifiedAutomationModel(provider, options.model);
  if (!approved || !actual || !Object.hasOwn(TIERS, authority.modelTier)
    || TIERS[approved.tier] > TIERS[authority.modelTier] || TIERS[actual.tier] > TIERS[authority.modelTier]) {
    refuseAutomationAuthority('the resolved model exceeds the approved model tier or cannot be verified');
  }
  if (!efforts.includes(authority.reasoningEffort) || !options.reasoningEffort || !efforts.includes(options.reasoningEffort)
    || REASONING_EFFORTS.indexOf(options.reasoningEffort) > REASONING_EFFORTS.indexOf(authority.reasoningEffort)) {
    refuseAutomationAuthority('the resolved effort exceeds the approved effort or cannot be enforced');
  }
  if (typeof authority.yoloMode !== 'boolean' || typeof options.yoloMode !== 'boolean'
    || (options.yoloMode && !authority.yoloMode)) refuseAutomationAuthority('the resolved auto-approval exceeds the approval snapshot');
  if (options.modelRuntimeTarget || options.launchMode === 'interactive') refuseAutomationAuthority('this runtime cannot enforce the approval snapshot');
  // The Claude constructor otherwise inherits the operator's global fallback.
  // An explicit equal model suppresses that fallback flag in the native argv.
  return { ...options, automationAuthority: Object.freeze({ ...authority }), model: actual.id, ...(provider === 'claude' ? { fallbackModel: actual.id } : {}) };
}

export function assertBoundedAutomationDestination(action: AutomationAction, destination: AutomationDestination): void {
  if (action.executionAuthority && (destination.kind !== 'newInstance' || action.systemAction || action.forceNodeId)) {
    refuseAutomationAuthority('existing threads, system actions and remote placement cannot carry this approval snapshot');
  }
}

/** Return a deterministic failure before thread wakeups or system dispatch can consume executable text. */
export function refuseAutomationAuthorityDispatch(
  claimed: import('../../shared/types/automation.types').ClaimedAutomationRun,
  store: Pick<import('./automation-store').AutomationStore, 'terminalizeRun'>,
  now: number,
  onTerminal: (run: import('../../shared/types/automation.types').AutomationRun, options: { retryable: false }) => void,
): boolean {
  try { assertBoundedAutomationDestination(claimed.snapshot.action, claimed.snapshot.destination); }
  catch (error) {
    const failed = store.terminalizeRun(claimed.run.id, 'failed', (error as Error).message, undefined, now);
    if (failed) onTerminal(failed, { retryable: false });
    return true;
  }
  return false;
}
