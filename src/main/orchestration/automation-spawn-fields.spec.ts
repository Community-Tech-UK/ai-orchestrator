import { afterEach, describe, expect, it } from 'vitest';
import { _setOutputCapSettingsReaderForTesting } from '../cli/adapters/claude-output-caps';
import { applyAutomationSpawnFields } from './automation-spawn-fields';

describe('direct orchestration spawn fields', () => {
  afterEach(() => _setOutputCapSettingsReaderForTesting(null));

  it('uses the machine ceiling and configured Claude output cap for a loop spawn', () => {
    _setOutputCapSettingsReaderForTesting((key) => key === 'claudeBashOutputMaxChars' ? 12_000 : undefined);
    const read = (key: string) => key === 'machineContextCeilingTokens' ? 300_000 : 120_000;
    expect(applyAutomationSpawnFields('claude', { trialKey: 'loop-run-1' }, 'loop-run', read)).toMatchObject({
      trialKey: 'loop-run-1', trialKeySource: 'loop-run', contextCeilingTokens: 300_000,
      bashOutputMaxChars: 12_000,
    });
  });

  it('keeps explicit overrides and never invents a trial group without a key', () => {
    _setOutputCapSettingsReaderForTesting(() => 12_000);
    const options = applyAutomationSpawnFields('claude', {
      contextCeilingTokens: 0, bashOutputMaxChars: 0,
    }, 'loop-run', () => 300_000);
    expect(options).toMatchObject({ contextCeilingTokens: 0, bashOutputMaxChars: 0 });
    expect(options.trialKeySource).toBeUndefined();
    expect(applyAutomationSpawnFields('codex', { trialKey: 'loop-run-1' }, 'loop-run')).toMatchObject({
      trialKey: 'loop-run-1', trialKeySource: 'loop-run',
    });
  });
});
