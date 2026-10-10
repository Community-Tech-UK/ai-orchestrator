import { describe, expect, it } from 'vitest';
import { applyOpenCodeGenerationBudget, assertOpenCodeGenerationBudget } from './opencode-generation-budget';

describe('scoped OpenCode generation budget', () => {
  it('caps the exact Xiaomi token-plan MiMo model and preserves provider configuration', () => {
    const base = { provider: { 'xiaomi-token-plan-ams': { name: 'MiMo', options: { baseURL: 'https://example.test/v1' }, models: { 'mimo-v2.6-pro': { options: { thinking: { type: 'enabled' } }, limit: { context: 1_000_000, output: 131072 } } } } } };
    const budget = applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan-ams/mimo-v2.6-pro');
    expect(budget).toEqual({ model: 'xiaomi-token-plan-ams/mimo-v2.6-pro', combinedOutputTokens: 16384, reasoningBudgetSupported: false });
    expect(base.provider['xiaomi-token-plan-ams'].models['mimo-v2.6-pro'].limit.output).toBe(16384);
    expect(base.provider['xiaomi-token-plan-ams'].models['mimo-v2.6-pro'].options).toEqual({ thinking: { type: 'enabled' }, max_completion_tokens: 16384 });
    expect(base.provider['xiaomi-token-plan-ams'].options.baseURL).toBe('https://example.test/v1');
  });
  it('scopes the budget to per-account aio-mimo providers too', () => {
    const base = { provider: { 'aio-mimo-max-b-1a2b': { name: 'MiMo B', options: { baseURL: 'https://example.test/v1' }, models: { 'mimo-v2.6-pro': { limit: { context: 1_000_000, output: 16384 } } } } } };
    const budget = applyOpenCodeGenerationBudget(base, 'aio-mimo-max-b-1a2b/mimo-v2.6-pro');
    expect(budget).toEqual({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro', combinedOutputTokens: 16384, reasoningBudgetSupported: false });
    expect(base.provider['aio-mimo-max-b-1a2b'].models['mimo-v2.6-pro'].limit.output).toBe(16384);
    expect(applyOpenCodeGenerationBudget({}, 'aio-mimo-max-b-1a2b/mimo-v2.6-flash')).toBeUndefined();
    expect(applyOpenCodeGenerationBudget({}, 'aio-mimo/mimo-v2.6-pro')).toBeUndefined();
  });
  it('retains a tighter configured cap and its context limit', () => {
    const base = { provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': { limit: { context: 800000, output: 4096 } } } } } };
    expect(applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro')?.combinedOutputTokens).toBe(4096);
    expect(base.provider['xiaomi-token-plan'].models['mimo-v2.6-pro'].limit.context).toBe(800000);
  });
  it('uses the verified model context when no overlay exists', () => {
    const base: Record<string, unknown> = {};
    applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro');
    expect(base).toMatchObject({ provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': { options: { max_completion_tokens: 16384 }, limit: { context: 1_000_000, output: 16384 } } } } } });
  });
  it('preserves a tighter documented completion cap and aligns its diagnostic budget', () => {
    const base = { provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
      options: { max_completion_tokens: 1024, thinking: { type: 'enabled' } },
      limit: { context: 800000, output: 4096 },
    } } } } };
    expect(applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro')?.combinedOutputTokens).toBe(1024);
    expect(base.provider['xiaomi-token-plan'].models['mimo-v2.6-pro']).toEqual({
      options: { max_completion_tokens: 1024, thinking: { type: 'enabled' } },
      limit: { context: 800000, output: 1024 },
    });
  });
  it('retains effective native caps/context without copying native model options into the overlay', () => {
    const base: Record<string, unknown> = {};
    const effective = { provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
      options: { max_completion_tokens: 1024, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' },
      limit: { context: 800000, output: 4096 },
    } } } } };
    expect(applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro', effective)?.combinedOutputTokens).toBe(1024);
    expect(base).toEqual({ provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
      options: { max_completion_tokens: 1024 }, limit: { context: 800000, output: 1024 },
    } } } } });
    expect(effective.provider['xiaomi-token-plan'].models['mimo-v2.6-pro'].limit.output).toBe(4096);
  });
  it.each(['openai/gpt-5.4', 'opencode/mimo-v2.6-pro', 'xiaomi-token-plan/mimo-v2.6-flash', 'xiaomi-token-planning/mimo-v2.6-pro', undefined])('does not alter unconfigured model %s', (model) => {
    const base = {};
    expect(applyOpenCodeGenerationBudget(base, model)).toBeUndefined();
    expect(base).toEqual({});
  });
  it('clamps later agent and direct variant options to the tightest scoped cap with truthful metadata', () => {
    const base = { provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
      limit: { context: 800000, output: 4096 }, options: { max_completion_tokens: 1024 },
      variants: { high: { max_completion_tokens: 32768, reasoningEffort: 'high' }, low: { max_completion_tokens: 512 } },
    } } } }, agent: { build: { options: { max_completion_tokens: 256, other: true } } } };
    const budget = applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro')!;
    expect(budget.combinedOutputTokens).toBe(256);
    expect(base.provider['xiaomi-token-plan'].models['mimo-v2.6-pro']).toEqual({
      limit: { context: 800000, output: 256 }, options: { max_completion_tokens: 256 },
      variants: { high: { max_completion_tokens: 256, reasoningEffort: 'high' }, low: { max_completion_tokens: 256 } },
    });
    expect(base.agent.build.options).toEqual({ max_completion_tokens: 256, other: true });
    expect(() => assertOpenCodeGenerationBudget(base, budget)).not.toThrow();
  });
  it('uses native top-level agent normalization without copying private agent or variant fields', () => {
    const base: Record<string, unknown> = {};
    const native = { provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
      limit: { context: 800000, output: 4096 }, options: { max_completion_tokens: 1024 },
      variants: { high: { max_completion_tokens: 32768, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' } },
    } } } }, agent: { build: { max_completion_tokens: 256, options: { max_completion_tokens: 32768, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' }, prompt: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' } } };
    expect(applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro', native)?.combinedOutputTokens).toBe(256);
    expect(base).toMatchObject({ agent: { build: { max_completion_tokens: 256, options: { max_completion_tokens: 256 } } } });
    expect(JSON.stringify(base)).not.toContain('LOCAL_PRIVATE_BODY_PLACEHOLDER');
  });
  it('preserves explicit unrelated subagent budgets and other models', () => {
    const base = { provider: { 'other-provider': { models: { 'other-model': { limit: { output: 32768 } } } } },
      agent: { researcher: { model: 'other-provider/other-model', mode: 'subagent', options: { max_completion_tokens: 32768 } } } };
    const unrelated = structuredClone(base);
    expect(applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro')?.combinedOutputTokens).toBe(16384);
    expect(base.agent).toEqual(unrelated.agent);
    expect(base.provider['other-provider']).toEqual(unrelated.provider['other-provider']);
  });
  it('retains smaller native agent and variant caps when the overlay has the same names', () => {
    const base = { agent: { build: { options: { max_completion_tokens: 32768 } } }, provider: {
      'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': { variants: { high: { max_completion_tokens: 32768 } } } } },
    } };
    const native = { agent: { build: { options: { max_completion_tokens: 256 } } }, provider: {
      'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': { variants: { high: { max_completion_tokens: 128 } } } } },
    } };
    const originalNative = structuredClone(native);
    expect(applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro', native)?.combinedOutputTokens).toBe(128);
    expect(base.agent.build.options.max_completion_tokens).toBe(128);
    expect(base.provider['xiaomi-token-plan'].models['mimo-v2.6-pro'].variants.high.max_completion_tokens).toBe(128);
    expect(native).toEqual(originalNative);
  });
  it('preserves an unrelated custom subagent whose model and mode are inherited from native config', () => {
    const base = { agent: { researcher: { options: { max_completion_tokens: 32768 } } } };
    const native = { agent: { researcher: { model: 'other-provider/other-model', mode: 'subagent', options: { max_completion_tokens: 32768 } } } };
    expect(applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro', native)?.combinedOutputTokens).toBe(16384);
    expect(base.agent.researcher.options.max_completion_tokens).toBe(32768);
    expect(Object.keys(base.agent.researcher)).toEqual(['options']);
  });
  it('preserves explicitly unrelated native general/explore subagents without requiring redundant mode config', () => {
    const base = { agent: { general: { model: 'other-provider/vendor/other-model', options: { max_completion_tokens: 32768 } },
      explore: { model: 'other-provider/vendor/other-model', options: { max_completion_tokens: 65536 } } } };
    const agents = structuredClone(base.agent);
    applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro');
    expect(base.agent).toEqual(agents);
  });
  it.each([undefined, 'primary', 'all'])('refuses cross-model native primary agent overrides in mode %s', (mode) => {
    const base = { agent: { build: { model: 'other-provider/other-model', mode, options: { max_completion_tokens: 32768 } } } };
    expect(() => applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro')).toThrow('cross-model primary');
    expect(base.agent.build.options.max_completion_tokens).toBe(32768);
  });
  it('refuses unscoped native auxiliary agent caps and configured plugins only for the selected MiMo model', () => {
    expect(() => applyOpenCodeGenerationBudget({ agent: { title: { options: { max_completion_tokens: 32768 } } } }, 'xiaomi-token-plan/mimo-v2.6-pro')).toThrow('auxiliary agents');
    const plugin = { plugin: ['LOCAL_PLUGIN_PLACEHOLDER'] };
    expect(() => applyOpenCodeGenerationBudget(plugin, 'xiaomi-token-plan/mimo-v2.6-pro')).toThrow('plugin overrides');
    expect(applyOpenCodeGenerationBudget(plugin, 'other-provider/other-model')).toBeUndefined();
    expect(plugin).toEqual({ plugin: ['LOCAL_PLUGIN_PLACEHOLDER'] });
  });
  it.each([null, '32768', 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses an unknown native completion option %s', (cap) => {
    expect(() => applyOpenCodeGenerationBudget({ agent: { build: { options: { max_completion_tokens: cap } } } }, 'xiaomi-token-plan/mimo-v2.6-pro')).toThrow('numeric limit');
  });
  it('rejects a later native override even when the minimum still agrees with the diagnostic ceiling', () => {
    const base: Record<string, unknown> = { agent: { build: { options: { max_completion_tokens: 32768 } } } };
    const budget = applyOpenCodeGenerationBudget(base, 'xiaomi-token-plan/mimo-v2.6-pro')!;
    (base['agent'] as { build: { options: { max_completion_tokens: number } } }).build.options.max_completion_tokens = 32768;
    expect(() => assertOpenCodeGenerationBudget(base, budget)).toThrow('effective scoped');
  });
});
