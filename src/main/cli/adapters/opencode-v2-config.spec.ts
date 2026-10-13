import { describe, expect, it } from 'vitest';
import { mirrorOpenCodeProviderForV2, normalizeOpenCodeNativeConfig } from './opencode-v2-config';
import { projectOpenCodeConfig } from './opencode-config-shapes';
import { applyOpenCodeGenerationBudget, assertOpenCodeGenerationBudget } from './opencode-generation-budget';

describe('OpenCode 2 config projection', () => {
  it('folds source documents into the legacy budget shape without credential fields', () => {
    const projected = projectOpenCodeConfig(normalizeOpenCodeNativeConfig([
      { type: 'document', info: { $schema: 'https://opencode.ai/config.json' } },
      { type: 'directory', path: '/tmp/opencode' },
      { type: 'document', info: {
        permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'doom_loop*', resource: '*', effect: 'ask' }],
        agents: { build: { permissions: [{ action: 'doom_loop', resource: '*', effect: 'ask' }], model: { providerID: 'xiaomi-token-plan', id: 'mimo-v2.6-pro' } } },
        providers: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
          limit: { context: 1048576, output: 16384 },
          headers: { authorization: 'LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER' },
        } } } },
      } },
    ]), 'xiaomi-token-plan/mimo-v2.6-pro');
    expect(projected).toMatchObject({
      permission: { '*': 'allow', 'doom_loop*': 'ask' },
      agent: { build: { model: 'xiaomi-token-plan/mimo-v2.6-pro', permission: { doom_loop: 'ask' } } },
      provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
        options: { max_completion_tokens: 16384 },
        limit: { context: 1048576, output: 16384 },
      } } } },
    });
    expect(JSON.stringify(projected)).not.toContain('LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER');
  });

  it('keeps effort-only and mixed variants so the budget clamps every thinking level', () => {
    const model = 'aio-mimo-demo/mimo-v2.6-pro';
    const projected = projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: {
      providers: { 'aio-mimo-demo': { models: {
        'mimo-v2.5': { variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] },
        'mimo-v2.6-pro': { limit: { context: 1000000, output: 16384 }, variants: [
          { id: 'low', settings: { reasoningEffort: 'low' } },
          { id: 'medium', settings: { reasoningEffort: 'medium', maxTokens: 4096 } },
          { id: 'high', settings: { reasoningEffort: 'high', max_completion_tokens: 8192, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' } },
        ] },
      } } },
    } }]), model);
    expect(projected).toMatchObject({ provider: { 'aio-mimo-demo': { models: { 'mimo-v2.6-pro': {
      variants: { low: {}, medium: { max_completion_tokens: 4096 }, high: { max_completion_tokens: 8192 } },
    } } } } });
    expect(JSON.stringify(projected)).not.toContain('reasoningEffort');
    expect(JSON.stringify(projected)).not.toContain('LOCAL_PRIVATE_BODY_PLACEHOLDER');
    const overlay: Record<string, unknown> = {};
    const budget = applyOpenCodeGenerationBudget(overlay, model, projected)!;
    expect(budget.combinedOutputTokens).toBe(4096);
    expect(overlay).toMatchObject({ provider: { 'aio-mimo-demo': { models: { 'mimo-v2.6-pro': {
      variants: { low: { max_completion_tokens: 4096 }, medium: { max_completion_tokens: 4096 }, high: { max_completion_tokens: 4096 } },
    } } } } });
    expect(() => assertOpenCodeGenerationBudget(overlay, budget)).not.toThrow();
    expect(() => assertOpenCodeGenerationBudget(projected, budget)).toThrow('effective scoped');
  });

  it('inherits the model ceiling for variants with no numeric override, including empty settings', () => {
    const model = 'aio-mimo-demo/mimo-v2.6-pro';
    const projected = projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: {
      providers: { 'aio-mimo-demo': { models: { 'mimo-v2.6-pro': {
        limit: { context: 1000000, output: 16384 }, variants: [
          { id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'medium', settings: {} }, { id: 'high' },
        ],
      } } } },
    } }]), model);
    const overlay: Record<string, unknown> = {};
    expect(applyOpenCodeGenerationBudget(overlay, model, projected)?.combinedOutputTokens).toBe(16384);
    expect(overlay).toMatchObject({ provider: { 'aio-mimo-demo': { models: { 'mimo-v2.6-pro': {
      variants: { low: { max_completion_tokens: 16384 }, medium: { max_completion_tokens: 16384 }, high: { max_completion_tokens: 16384 } },
    } } } } });
  });

  it.each([null, '4096', 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses explicit invalid numeric variant limits %s', (cap) => {
    for (const key of ['max_completion_tokens', 'maxTokens']) {
      expect(() => normalizeOpenCodeNativeConfig([{ type: 'document', info: {
        providers: { demo: { models: { one: { variants: [{ id: 'high', settings: { [key]: cap } }] } } } },
      } }])).toThrow('Unsupported native numeric limit');
    }
  });

  it('retains the tighter cap when both native numeric aliases are present', () => {
    expect(projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: {
      providers: { demo: { models: { one: { variants: [{ id: 'high', settings: { max_completion_tokens: 8192, maxTokens: 2048 } }] } } } },
    } }]), 'demo/one')).toMatchObject({ provider: { demo: { models: { one: { variants: { high: { max_completion_tokens: 2048 } } } } } } });
  });

  it.each([null, {}, { id: '' }, { id: ' ' }, { id: 42 }, { id: 'high', settings: null }, { id: 'high', settings: [] }, { id: 'high', settings: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' }])('refuses malformed native variants %j', (variant) => {
    expect(() => normalizeOpenCodeNativeConfig([{ type: 'document', info: {
      providers: { demo: { models: { one: { variants: [variant] } } } },
    } }])).toThrow('Unsupported native variant configuration');
  });

  it('copies the legacy provider tree to the OpenCode 2 key', () => {
    const config: Record<string, unknown> = { provider: { demo: { models: { one: { limit: { output: 128 } } } } } };
    mirrorOpenCodeProviderForV2(config);
    expect(config['providers']).toEqual(config['provider']);
  });
});
