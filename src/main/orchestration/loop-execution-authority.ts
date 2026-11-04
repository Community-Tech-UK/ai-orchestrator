import type { LoopConfig } from '../../shared/types/loop.types';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory.types';
import { boundAutomationSpawnOptions, refuseAutomationAuthority } from '../automations/automation-execution-authority';

type ExecutionConfig = Pick<Partial<LoopConfig>, 'provider' | 'model' | 'reasoningEffort' | 'yoloMode' | 'executionAuthority'>;

export function loopExecutionSpawnOptions(config: ExecutionConfig = {}, provider: string | undefined = config.provider): Partial<UnifiedSpawnOptions> {
  const authority = config.executionAuthority;
  const options = {
    model: config.model ?? authority?.model,
    reasoningEffort: config.reasoningEffort ?? authority?.reasoningEffort,
    yoloMode: config.yoloMode ?? authority?.yoloMode ?? true,
  };
  return boundAutomationSpawnOptions(authority, provider ?? '', options);
}

export function hasPinnedLoopExecution(config: ExecutionConfig = {}): boolean {
  return !!config.executionAuthority || config.model !== undefined || config.reasoningEffort !== undefined || config.yoloMode !== undefined;
}

/** Validate restored configs too. Extra model roles must be integrated before they may run bounded work. */
export function assertLoopExecutionAuthority(config: Partial<LoopConfig> = {}): void {
  if (!config.executionAuthority) return;
  loopExecutionSpawnOptions(config);
  if (config.completion?.mode === 'review-driven' || config.completion?.crossModelReview?.enabled
    || config.completion?.crossModelReview?.pingPong?.enabled || config.exploration?.enabled
    || config.failover?.enabled || config.semanticProgress?.enabled || config.nextObjectivePlanning?.enabled
    || config.nextObjectivePlanner || config.phase4?.subagentContracts?.enabled) {
    refuseAutomationAuthority('additional model roles or provider failover cannot enforce the saved limits');
  }
}

const adapterSettings = new WeakMap<object, string>();
function settingsKey(config: ExecutionConfig): string {
  return JSON.stringify([config.provider, config.model, config.reasoningEffort, config.yoloMode, config.executionAuthority]);
}
export function rememberLoopExecutionSettings(adapter: object, config: ExecutionConfig): void {
  adapterSettings.set(adapter, settingsKey(config));
}
export function loopAdapterHonorsAuthority(adapter: unknown, config: ExecutionConfig): boolean {
  return !hasPinnedLoopExecution(config) || (typeof adapter === 'object' && adapter !== null && adapterSettings.get(adapter) === settingsKey(config));
}

/** Even a coordinator-forced role must not bypass a scheduled execution ceiling. */
export function assertLoopModelRoleAuthority(config: Partial<LoopConfig>): void {
  if (config.executionAuthority) refuseAutomationAuthority('the additional reviewer cannot enforce the saved limits');
}
