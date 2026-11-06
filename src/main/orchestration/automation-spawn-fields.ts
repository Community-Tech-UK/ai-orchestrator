import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory.types';
import { resolveContextCeilingTokens } from '../cli/adapters/context-ceiling';
import { resolveClaudeBashOutputMaxChars } from '../cli/adapters/claude-output-caps';

/** Shared fields for direct orchestration adapter spawns that bypass instance lifecycle. */
export function applyAutomationSpawnFields(
  cliType: string,
  options: UnifiedSpawnOptions,
  trialKeySource?: UnifiedSpawnOptions['trialKeySource'],
  readContextSetting?: (key: string) => unknown,
): UnifiedSpawnOptions {
  return {
    ...options,
    ...(options.trialKey && trialKeySource && !options.trialKeySource ? { trialKeySource } : {}),
    ...(cliType === 'claude' ? {
      contextCeilingTokens: options.contextCeilingTokens ?? resolveContextCeilingTokens(true, readContextSetting),
      bashOutputMaxChars: options.bashOutputMaxChars ?? resolveClaudeBashOutputMaxChars(),
    } : {}),
  };
}
