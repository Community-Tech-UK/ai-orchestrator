import { describe, expect, it, vi } from 'vitest';

import { COPILOT_MODELS } from '../../../shared/types/provider.types';
import {
  classifyCopilotModelFamily,
  classifyCopilotModelTier,
  completeCopilotDiscoveredModels,
  COPILOT_DEFAULT_MODELS,
  parseCopilotModelIdsFromHelpConfig,
  unionCopilotModelIds,
  withCopilotModelListFallback,
} from './copilot-cli-adapter.models';

const HELP_CONFIG_FIXTURE = `
Configuration Settings:

  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-5"
    - "claude-opus-5"
    - "gpt-5.6-sol"
    - "gpt-5.6-terra"
    - "gpt-5.6-luna"
    - "gpt-5.5"
    - "gpt-5.3-codex"
    - "gpt-5.4-mini"

  \`contextTier\`: context window tier for tiered-pricing models (e.g., "default" or "long_context").
`;

describe('parseCopilotModelIdsFromHelpConfig', () => {
  it('reads the 1.0.83 help-config roster, including the flag-option header suffix', () => {
    expect(parseCopilotModelIdsFromHelpConfig(HELP_CONFIG_FIXTURE)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.3-codex',
      'gpt-5.4-mini',
    ]);
  });

  it('returns no ids when the model section is missing', () => {
    expect(parseCopilotModelIdsFromHelpConfig('`banner`: frequency of showing animated banner')).toEqual([]);
  });
});

describe('completeCopilotDiscoveredModels', () => {
  it('keeps help-config order and appends static omissions such as gpt-6-astra', () => {
    const discovered = parseCopilotModelIdsFromHelpConfig(HELP_CONFIG_FIXTURE);
    const models = completeCopilotDiscoveredModels(discovered);
    const ids = models.map((model) => model.id);

    expect(ids.slice(0, discovered.length)).toEqual(discovered);
    expect(ids).toContain(COPILOT_MODELS.GPT6_ASTRA);
    expect(ids).toContain(COPILOT_MODELS.AUTO);
    expect(ids.indexOf(COPILOT_MODELS.GPT6_ASTRA)).toBeGreaterThan(
      ids.indexOf('gpt-5.6-luna'),
    );
  });

  it('unions without duplicating ids already present in the live roster', () => {
    expect(unionCopilotModelIds(['gpt-6-astra', 'gpt-5.5'], ['gpt-6-astra', 'auto'])).toEqual([
      'gpt-6-astra',
      'gpt-5.5',
      'auto',
    ]);
  });

  it('keeps live Copilot ids that are retired on other providers', () => {
    const ids = completeCopilotDiscoveredModels(['claude-fable-5', 'grok-4.5']).map((model) => model.id);
    expect(ids).toContain('claude-fable-5');
    expect(ids).toContain('grok-4.5');
  });
});

describe('Copilot fallback list', () => {
  it('includes Astra and the GPT-5.6 family even when help config is unreachable', () => {
    const ids = COPILOT_DEFAULT_MODELS.map((model) => model.id);
    expect(ids).toContain(COPILOT_MODELS.GPT6_ASTRA);
    expect(ids).toContain(COPILOT_MODELS.GPT56_SOL);
    expect(ids).toContain(COPILOT_MODELS.GPT56_TERRA);
    expect(ids).toContain(COPILOT_MODELS.GPT56_LUNA);
    expect(ids).toContain(COPILOT_MODELS.CLAUDE_SONNET_5);
  });

  it('rethrows when catalog discovery has disabled the static fallback', async () => {
    await expect(
      withCopilotModelListFallback(Promise.reject(new Error('parse failed')), false),
    ).rejects.toThrow('parse failed');
  });

  it('returns the static fallback and notifies when fallback is allowed', async () => {
    const onFallback = vi.fn();
    const models = await withCopilotModelListFallback(
      Promise.reject(new Error('timeout')),
      true,
      onFallback,
    );
    expect(models).toBe(COPILOT_DEFAULT_MODELS);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});

describe('Copilot picker classification', () => {
  it('tiers Astra and Sol as powerful, Luna as fast', () => {
    expect(classifyCopilotModelTier(COPILOT_MODELS.GPT6_ASTRA)).toBe('powerful');
    expect(classifyCopilotModelTier(COPILOT_MODELS.GPT56_SOL)).toBe('powerful');
    expect(classifyCopilotModelTier(COPILOT_MODELS.GPT56_LUNA)).toBe('fast');
    expect(classifyCopilotModelTier(COPILOT_MODELS.GPT56_TERRA)).toBe('balanced');
  });

  it('families new Copilot ids for Other versions grouping', () => {
    expect(classifyCopilotModelFamily(COPILOT_MODELS.GPT6_ASTRA)).toBe('GPT');
    expect(classifyCopilotModelFamily(COPILOT_MODELS.CLAUDE_SONNET_5)).toBe('Claude');
    expect(classifyCopilotModelFamily(COPILOT_MODELS.KIMI_K3)).toBe('Kimi');
    expect(classifyCopilotModelFamily(COPILOT_MODELS.GROK_45)).toBe('Grok');
  });
});
