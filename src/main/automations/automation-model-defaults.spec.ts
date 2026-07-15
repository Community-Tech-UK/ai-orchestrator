import { describe, expect, it } from 'vitest';
import {
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
} from './automation-model-defaults';

const NO_DEFAULTS: AutomationModelDefaults = {
  automationDefaultCli: 'auto',
  automationDefaultModel: '',
};

describe('resolveAutomationSpawnTarget', () => {
  it('leaves fields untouched when the automation is Auto and no default is set', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      NO_DEFAULTS,
    );
    expect(target).toEqual({ provider: 'auto', modelOverride: undefined });
  });

  it('applies the dedicated default when the automation is Auto', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      { automationDefaultCli: 'claude', automationDefaultModel: 'opus[1m]' },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: 'opus[1m]' });
  });

  it('keeps a pinned automation model even when a default is configured', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'codex', model: 'gpt-5.6-sol' },
      { automationDefaultCli: 'claude', automationDefaultModel: 'opus[1m]' },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('applies only the default model when the automation pins a provider but not a model', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      { automationDefaultCli: 'auto', automationDefaultModel: 'opus[1m]' },
    );
    expect(target).toEqual({ provider: 'auto', modelOverride: 'opus[1m]' });
  });

  it('normalizes the legacy openai provider to codex', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      { automationDefaultCli: 'openai', automationDefaultModel: 'gpt-5.6-sol' },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('treats a whitespace-only default model as unset', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      { automationDefaultCli: 'auto', automationDefaultModel: '   ' },
    );
    expect(target).toEqual({ provider: 'auto', modelOverride: undefined });
  });
});
