import { describe, expect, it } from 'vitest';
import {
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
} from './automation-model-resolution';

const NO_DEFAULTS: AutomationModelDefaults = {
  automationDefaultCli: 'auto',
  automationDefaultModel: '',
  modelPickerFavorites: [],
};

describe('resolveAutomationSpawnTarget — pre-favourite behaviour (unchanged)', () => {
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
      { ...NO_DEFAULTS, automationDefaultCli: 'claude', automationDefaultModel: 'opus[1m]' },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: 'opus[1m]' });
  });

  it('does not hand a Claude default model to a codex automation', () => {
    // automationDefaultModel is one cross-provider setting. Setting it to a
    // Claude model must not silently misconfigure every unpinned codex job.
    const target = resolveAutomationSpawnTarget(
      { provider: 'codex', model: undefined },
      { ...NO_DEFAULTS, automationDefaultModel: 'opus[1m]' },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: undefined });
  });

  it('does not hand a codex default model to a claude automation', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      { ...NO_DEFAULTS, automationDefaultModel: 'gpt-5.6-sol' },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: undefined });
  });

  it('still applies a matching default to a same-provider automation', () => {
    expect(
      resolveAutomationSpawnTarget(
        { provider: 'claude', model: undefined },
        { ...NO_DEFAULTS, automationDefaultModel: 'opus[1m]' },
      ),
    ).toEqual({ provider: 'claude', modelOverride: 'opus[1m]' });
    expect(
      resolveAutomationSpawnTarget(
        { provider: 'codex', model: undefined },
        { ...NO_DEFAULTS, automationDefaultModel: 'gpt-5.6-sol' },
      ),
    ).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('applies an unclassifiable default model unchanged, as before', () => {
    // A local selector or a provider we cannot classify must not regress.
    const target = resolveAutomationSpawnTarget(
      { provider: 'gemini', model: undefined },
      { ...NO_DEFAULTS, automationDefaultModel: 'some-local-model:7b' },
    );
    expect(target).toEqual({ provider: 'gemini', modelOverride: 'some-local-model:7b' });
  });

  it('falls through to the provider favourite when the default is the wrong family', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'codex', model: undefined },
      {
        ...NO_DEFAULTS,
        automationDefaultModel: 'opus[1m]',
        modelPickerFavorites: ['codex:gpt-5.6-sol'],
      },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('keeps a pinned automation model even when a default is configured', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'codex', model: 'gpt-5.6-sol' },
      { ...NO_DEFAULTS, automationDefaultCli: 'claude', automationDefaultModel: 'opus[1m]' },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('applies only the default model when the automation pins a provider but not a model', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      { ...NO_DEFAULTS, automationDefaultCli: 'auto', automationDefaultModel: 'opus[1m]' },
    );
    expect(target).toEqual({ provider: 'auto', modelOverride: 'opus[1m]' });
  });

  it('normalizes the legacy openai provider to codex', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      { ...NO_DEFAULTS, automationDefaultCli: 'openai', automationDefaultModel: 'gpt-5.6-sol' },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('treats a whitespace-only default model as unset', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      { ...NO_DEFAULTS, automationDefaultCli: 'auto', automationDefaultModel: '   ' },
    );
    expect(target).toEqual({ provider: 'auto', modelOverride: undefined });
  });
});

describe('resolveAutomationSpawnTarget — favourite fallback', () => {
  it('resolution order: pin > automationDefaultModel > favourite > provider default', () => {
    // Pin wins over everything.
    expect(
      resolveAutomationSpawnTarget(
        { provider: 'claude', model: 'opus' },
        {
          automationDefaultCli: 'auto',
          automationDefaultModel: 'sonnet-5',
          modelPickerFavorites: ['claude:fable-5'],
        },
      ),
    ).toEqual({ provider: 'claude', modelOverride: 'opus' });

    // No pin → automationDefaultModel wins over favourite.
    expect(
      resolveAutomationSpawnTarget(
        { provider: 'claude', model: undefined },
        {
          automationDefaultCli: 'auto',
          automationDefaultModel: 'sonnet-5',
          modelPickerFavorites: ['claude:fable-5'],
        },
      ),
    ).toEqual({ provider: 'claude', modelOverride: 'sonnet-5' });

    // No pin, no default → favourite for the provider wins over provider default.
    expect(
      resolveAutomationSpawnTarget(
        { provider: 'claude', model: undefined },
        { ...NO_DEFAULTS, modelPickerFavorites: ['claude:opus[1m]'] },
      ),
    ).toEqual({ provider: 'claude', modelOverride: 'opus[1m]' });
  });

  it('AC1: chooses the first matching favourite for the resolved provider', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      {
        ...NO_DEFAULTS,
        modelPickerFavorites: ['codex:gpt-5.6-sol', 'claude:opus[1m]', 'claude:sonnet-5'],
      },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: 'opus[1m]' });
  });

  it('AC1: reordering favourites redirects the resolved model', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      {
        ...NO_DEFAULTS,
        modelPickerFavorites: ['claude:sonnet-5', 'claude:opus[1m]'],
      },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: 'sonnet-5' });
  });

  it('provider-prefix match only: a claude favourite is ignored for codex', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'codex', model: undefined },
      { ...NO_DEFAULTS, modelPickerFavorites: ['claude:opus[1m]'] },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: undefined });
  });

  it('AC4: pinned codex provider + only-claude favourites falls through to codex default', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'codex', model: undefined },
      { ...NO_DEFAULTS, modelPickerFavorites: ['claude:opus[1m]', 'claude:sonnet-5'] },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: undefined });
  });

  it('normalizes openai↔codex on both the favourite key and the provider', () => {
    // openai-prefixed favourite matches a codex automation.
    expect(
      resolveAutomationSpawnTarget(
        { provider: 'codex', model: undefined },
        { ...NO_DEFAULTS, modelPickerFavorites: ['openai:gpt-5.6-sol'] },
      ),
    ).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });

    // codex-prefixed favourite matches a legacy openai default provider.
    expect(
      resolveAutomationSpawnTarget(
        { provider: 'auto', model: undefined },
        {
          automationDefaultCli: 'openai',
          automationDefaultModel: '',
          modelPickerFavorites: ['codex:gpt-5.6-sol'],
        },
      ),
    ).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('preserves a colon inside the model id (splits on the first colon only)', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'codex', model: undefined },
      { ...NO_DEFAULTS, modelPickerFavorites: ['codex:vendor:model:v2'] },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: 'vendor:model:v2' });
  });

  it('ignores empty / whitespace / malformed favourite entries and falls through', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      {
        ...NO_DEFAULTS,
        modelPickerFavorites: ['', '   ', 'nocolon', ':leadingcolon', 'claude:', '  :  '],
      },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: undefined });
  });

  it('D1: provider auto + no defaults adopts the first favourite provider + model', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      {
        ...NO_DEFAULTS,
        modelPickerFavorites: ['claude:opus[1m]', 'codex:gpt-5.6-sol'],
      },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: 'opus[1m]' });
  });

  it('D1: provider auto skips malformed leading entries when adopting the top favourite', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: undefined, model: undefined },
      {
        ...NO_DEFAULTS,
        modelPickerFavorites: ['garbage', 'codex:gpt-5.6-sol', 'claude:opus[1m]'],
      },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: 'gpt-5.6-sol' });
  });

  it('D1: provider auto + an automationDefaultCli takes the prefix path, not adopt-top', () => {
    // automationDefaultCli resolves the provider to codex; only-claude
    // favourites therefore do not match and it falls through to the codex default.
    const target = resolveAutomationSpawnTarget(
      { provider: 'auto', model: undefined },
      {
        automationDefaultCli: 'codex',
        automationDefaultModel: '',
        modelPickerFavorites: ['claude:opus[1m]'],
      },
    );
    expect(target).toEqual({ provider: 'codex', modelOverride: undefined });
  });

  it('AC3: no favourites + no default is identical to today (fall-through)', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      NO_DEFAULTS,
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: undefined });
  });

  it('tolerates a non-array favourites value defensively', () => {
    const target = resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      { ...NO_DEFAULTS, modelPickerFavorites: undefined as unknown as string[] },
    );
    expect(target).toEqual({ provider: 'claude', modelOverride: undefined });
  });
});

describe('resolveAutomationSpawnTarget — retired model replacements', () => {
  it('runs an explicitly pinned Fable 5 automation on Fable 5.1 without rewriting the action', () => {
    const action = { provider: 'claude' as const, model: 'claude-fable-5' };

    expect(resolveAutomationSpawnTarget(action, NO_DEFAULTS)).toEqual({
      provider: 'claude',
      modelOverride: 'claude-fable-5-1',
    });
    expect(action).toEqual({ provider: 'claude', model: 'claude-fable-5' });
  });

  it('upgrades a retired automation-default model at fire time', () => {
    expect(resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      { ...NO_DEFAULTS, automationDefaultModel: 'claude-fable-5' },
    )).toEqual({ provider: 'claude', modelOverride: 'claude-fable-5-1' });
  });

  it('upgrades a retired model selected from the Claude favourites fallback', () => {
    expect(resolveAutomationSpawnTarget(
      { provider: 'claude', model: undefined },
      { ...NO_DEFAULTS, modelPickerFavorites: ['claude:claude-fable-5'] },
    )).toEqual({ provider: 'claude', modelOverride: 'claude-fable-5-1' });
  });

  it('infers the provider family before upgrading an auto-provider model pin', () => {
    expect(resolveAutomationSpawnTarget(
      { provider: 'auto', model: 'claude-fable-5' },
      NO_DEFAULTS,
    )).toEqual({ provider: 'auto', modelOverride: 'claude-fable-5-1' });
  });
});
