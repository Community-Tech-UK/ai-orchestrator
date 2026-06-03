import { describe, it, expect } from 'vitest';
import { resolveInitialModel } from '../resolve-initial-model';

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
