import { describe, it, expect } from 'vitest';
import { resolveInitialModel, resolveInitialModelWithSource } from '../resolve-initial-model';

describe('resolveInitialModel (A8a precedence)', () => {
  const byProvider = { claude: 'opus', codex: 'gpt-5.3-codex', gemini: 'gemini-2.5-pro' };

  it('explicit config override wins over everything', () => {
    expect(
      resolveInitialModel({
        configModelOverride: 'sonnet',
        agentModelOverride: 'haiku',
        provider: 'claude',
        defaultModelByProvider: byProvider,
        defaultModel: 'opus[1m]',
      }),
    ).toBe('sonnet');
  });

  it('agent override wins over per-provider remembered + default', () => {
    expect(
      resolveInitialModel({
        agentModelOverride: 'haiku',
        provider: 'claude',
        defaultModelByProvider: byProvider,
        defaultModel: 'opus[1m]',
      }),
    ).toBe('haiku');
  });

  it('per-provider remembered wins over the legacy global default', () => {
    expect(
      resolveInitialModel({
        provider: 'codex',
        defaultModelByProvider: byProvider,
        defaultModel: 'opus[1m]',
      }),
    ).toBe('gpt-5.3-codex');
  });

  it('falls back to the global default when no per-provider model is remembered', () => {
    expect(
      resolveInitialModel({
        provider: 'copilot', // not present in byProvider
        defaultModelByProvider: byProvider,
        defaultModel: 'opus[1m]',
      }),
    ).toBe('opus[1m]');
  });

  it('falls back to the global default when the map is absent', () => {
    expect(
      resolveInitialModel({ provider: 'codex', defaultModel: 'opus[1m]' }),
    ).toBe('opus[1m]');
  });

  it('returns undefined when no source supplies a model', () => {
    expect(
      resolveInitialModel({ provider: 'codex', defaultModelByProvider: {} }),
    ).toBeUndefined();
  });

  it('ignores the per-provider map when provider is empty', () => {
    expect(
      resolveInitialModel({
        provider: '',
        defaultModelByProvider: { '': 'should-not-be-used' },
        defaultModel: 'opus[1m]',
      }),
    ).toBe('opus[1m]');
  });

  it('does not treat an empty-string override as a real choice', () => {
    // empty strings are falsy → resolution continues down the ladder
    expect(
      resolveInitialModel({
        configModelOverride: '',
        agentModelOverride: '',
        provider: 'claude',
        defaultModelByProvider: byProvider,
        defaultModel: 'opus[1m]',
      }),
    ).toBe('opus');
  });
});

/**
 * LT-016. The suppression that keeps a provider-agnostic global default from
 * being reported as the user's stale selection is only sound if provenance and
 * decision agree. They now come from one function, so this pins that contract
 * rather than a second implementation of it.
 */
describe('resolveInitialModelWithSource — decision and provenance agree', () => {
  const base = {
    provider: 'codex',
    defaultModelByProvider: { codex: 'remembered-model' },
    defaultModel: 'global-model',
  };

  const cases = [
    { name: 'explicit override wins',  input: { ...base, configModelOverride: 'asked-for', agentModelOverride: 'agent-model' }, model: 'asked-for',        source: 'requested' },
    { name: 'agent override next',     input: { ...base, agentModelOverride: 'agent-model' },                                   model: 'agent-model',      source: 'agent' },
    { name: 'remembered next',         input: { ...base },                                                                      model: 'remembered-model', source: 'remembered' },
    { name: 'global default last',     input: { ...base, defaultModelByProvider: {} },                                          model: 'global-model',     source: 'global-default' },
    { name: 'nothing at all',          input: { provider: 'codex' },                                                            model: undefined,          source: 'none' },
  ] as const;

  for (const c of cases) {
    it(c.name, () => {
      const r = resolveInitialModelWithSource(c.input);
      expect(r.model).toBe(c.model);
      expect(r.source).toBe(c.source);
      // The legacy single-value entry point must never disagree with it.
      expect(resolveInitialModel(c.input)).toBe(r.model);
    });
  }

  it('treats an empty-string rung as absent, on both the model and the source', () => {
    const r = resolveInitialModelWithSource({
      provider: 'codex',
      configModelOverride: '',
      agentModelOverride: '',
      defaultModelByProvider: { codex: '' },
      defaultModel: 'global-model',
    });
    expect(r).toEqual({ model: 'global-model', source: 'global-default' });
  });
});
