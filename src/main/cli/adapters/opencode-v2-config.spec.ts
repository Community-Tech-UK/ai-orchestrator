import { describe, expect, it } from 'vitest';
import { mirrorOpenCodeProviderForV2, normalizeOpenCodeNativeConfig, serializeOpenCodeConfigForV2 } from './opencode-v2-config';
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
          limit: { context: 1048576, output: 16384, input: 90000 },
          headers: { authorization: 'LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER' },
        } } } },
      } },
    ]), 'xiaomi-token-plan/mimo-v2.6-pro');
    expect(projected).toMatchObject({
      permission: { '*': 'allow', 'doom_loop*': 'ask' },
      agent: { build: { model: 'xiaomi-token-plan/mimo-v2.6-pro', permission: { doom_loop: 'ask' } } },
      provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
        options: { max_completion_tokens: 16384 },
        limit: { context: 1048576, output: 16384, input: 90000 },
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


describe('OpenCode 2 native settings', () => {
  it('preserves native action names and ordered resources', () => {
    const native = normalizeOpenCodeNativeConfig([{ type: 'document', info: { permissions: [
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'shell', resource: 'git push *', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'ask' },
    ] } }]) as Record<string, unknown>;
    expect(native['permissionRules']).toEqual([
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'shell', resource: 'git push *', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'ask' },
    ]);
  });
  it('reads the tightest cap from body, settings and options', () => {
    const projected = projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: {
      providers: { demo: { models: { one: { body: { max_completion_tokens: 512 }, settings: { maxTokens: 2048 }, options: { max_completion_tokens: 1024 }, limit: { output: 4096 } } } } },
    } }]), 'demo/one');
    expect(projected).toMatchObject({ provider: { demo: { models: { one: { options: { max_completion_tokens: 512 } } } } } });
  });
  it('writes native providers, body caps and ordered permissions without migration keys', () => {
    const config: Record<string, unknown> = { permission: { bash: { '*': 'ask', 'git push *': 'deny' }, task: 'ask', doom_loop: 'ask' },
      provider: { demo: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://example.test/v1' }, models: { one: { options: { max_completion_tokens: 512 }, variants: { high: { reasoningEffort: 'high', max_completion_tokens: 256 } } } } } },
      agent: { build: { permission: { doom_loop: 'ask' }, options: { max_completion_tokens: 128 } } } };
    serializeOpenCodeConfigForV2(config);
    expect(config).toMatchObject({ permissions: [
      { action: 'shell', resource: '*', effect: 'ask' }, { action: 'shell', resource: 'git push *', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'ask' }, { action: 'doom_loop', resource: '*', effect: 'ask' },
    ], providers: { demo: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://example.test/v1' }, models: { one: {
      body: { max_completion_tokens: 512 }, variants: [{ id: 'high', settings: { reasoningEffort: 'high' }, body: { max_completion_tokens: 256 } }],
    } } } }, agents: { build: { request: { body: { max_completion_tokens: 128 } }, permissions: [{ action: 'doom_loop', resource: '*', effect: 'ask' }] } } });
    for (const key of ['permission', 'provider', 'agent']) expect(config).not.toHaveProperty(key);
  });
});


it('keeps native variant body caps and agent request caps in the budget projection', () => {
  const config = projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: {
    agents: { build: { model: { providerID: 'demo', model: 'one' }, request: { body: { max_completion_tokens: 128 } } } },
    providers: { demo: { models: { one: { limit: { output: 1024 }, variants: [{ id: 'high', body: { max_completion_tokens: 256 } }] } } } },
  } }]), 'demo/one');
  expect(config).toMatchObject({ agent: { build: { model: 'demo/one', options: { max_completion_tokens: 128 } } },
    provider: { demo: { models: { one: { variants: { high: { max_completion_tokens: 256 } } } } } } });
});


it('converts legacy cost and timeout fields to the native schema', () => {
 const config: Record<string, unknown> = { provider: { demo: { options: { baseURL: 'https://example.test', timeout: false }, models: { one: { cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 } } } } } };
 serializeOpenCodeConfigForV2(config);
 expect(config).toMatchObject({ providers: { demo: { settings: { timeout: false }, models: { one: { cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } } } } } } });
 const cost = ((config['providers'] as Record<string, { models: { one: { cost: Record<string, unknown> } } }>)['demo']!).models.one.cost;
 expect(cost).not.toHaveProperty('cache_read');
});


it('retains native provider models and agent context while final AIO caps take precedence', () => {
 const config: Record<string, unknown> = { providers: { demo: { models: { unrelated: { name: 'Keep' }, one: { body: { max_completion_tokens: 8192, other: true } } } } },
 provider: { demo: { models: { one: { options: { max_completion_tokens: 256 } } } } },
 agents: { build: { system: 'Keep native instructions', request: { body: { max_completion_tokens: 8192, other: true } } } }, agent: { build: { options: { max_completion_tokens: 128 } } } };
 serializeOpenCodeConfigForV2(config);
 expect(config).toMatchObject({ providers: { demo: { models: { unrelated: { name: 'Keep' }, one: { body: { max_completion_tokens: 256, other: true } } } } },
 agents: { build: { system: 'Keep native instructions', request: { body: { max_completion_tokens: 128, other: true } } } } });
});


it('observes a later source replacing the same native body cap so verification cannot accept an overridden budget', () => {
 const model = 'aio-mimo-demo/mimo-v2.6-pro';
 const documents = [512, 8192].map((cap) => ({ type: 'document', info: { providers: { 'aio-mimo-demo': { models: { 'mimo-v2.6-pro': { body: { max_completion_tokens: cap }, limit: { output: 32000, input: 140000 } } } } } } }));
 const projected = projectOpenCodeConfig(normalizeOpenCodeNativeConfig(documents), model);
 expect(projected).toMatchObject({ provider: { 'aio-mimo-demo': { models: { 'mimo-v2.6-pro': { options: { max_completion_tokens: 8192 } } } } } });
 expect(() => assertOpenCodeGenerationBudget(projected, { model, combinedOutputTokens: 512, reasoningBudgetSupported: false, inputLimit: 140000 })).toThrow('effective scoped');
});


it('preserves the configured native model for credential checks', () => {
 expect(normalizeOpenCodeNativeConfig([{ type: 'document', info: { model: { providerID: 'paid-provider', model: 'paid-model' } } }])).toMatchObject({ model: 'paid-provider/paid-model' });
});


it('keeps native action patterns in ordered global and agent rules while projecting exact legacy aliases separately', () => {
  const permissions = [
    { action: 'shell', resource: '*', effect: 'ask' },
    { action: 'shell*', resource: 'git *', effect: 'allow' },
    { action: 'she?l', resource: '*', effect: 'deny' },
    { action: 'subagent', resource: '*', effect: 'ask' },
    { action: 'subage?t', resource: '*', effect: 'allow' },
  ];
  const result = normalizeOpenCodeNativeConfig([{ type: 'document', info: {
    permissions, agents: { custom: { permissions } },
  } }]) as Record<string, unknown>;
  expect(result['permissionRules']).toEqual(permissions);
  expect((result['agent'] as Record<string, Record<string, unknown>>)['custom']!['permissionRules']).toEqual(permissions);
  expect(result['permission']).toEqual({ bash: 'ask', 'she?l': 'deny', task: 'ask', 'subage?t': 'allow' });
});


it('preserves native inline variant settings and metadata through the actual budget and serializer pipeline', () => {
  const model = 'xiaomi-token-plan-ams/mimo-v2.6-pro';
  const source = { providers: { 'xiaomi-token-plan-ams': { models: { 'mimo-v2.6-pro': {
    variants: [
      { id: 'custom', name: 'Custom effort', settings: { reasoningEffort: 'high', temperature: 0.123 }, body: { custom_flag: true } },
      { id: 'small', disabled: false, settings: { reasoningEffort: 'low' }, body: { max_completion_tokens: 4096, other_flag: 'keep' } },
    ],
  } } } } };
  const original = structuredClone(source);
  const config: Record<string, unknown> = structuredClone(source);
  const effective = normalizeOpenCodeNativeConfig([{ type: 'document', info: structuredClone(source) }]) as Record<string, unknown>;
  const budget = applyOpenCodeGenerationBudget(config, model, effective)!;
  serializeOpenCodeConfigForV2(config);
  expect(config).toMatchObject({ providers: { 'xiaomi-token-plan-ams': { models: { 'mimo-v2.6-pro': {
    variants: [
      { id: 'custom', name: 'Custom effort', settings: { reasoningEffort: 'high', temperature: 0.123 }, body: { custom_flag: true, max_completion_tokens: 4096 } },
      { id: 'small', disabled: false, settings: { reasoningEffort: 'low' }, body: { max_completion_tokens: 4096, other_flag: 'keep' } },
    ],
  } } } } });
  const projected = projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: config }]), model);
  expect(budget.combinedOutputTokens).toBe(4096);
  expect(() => assertOpenCodeGenerationBudget(projected, budget)).not.toThrow();
  expect(source).toEqual(original);
});

it.each([false, true])('merges variant definitions by id without losing absent native variants (native incoming: %s)', (nativeIncoming) => {
  const incoming = nativeIncoming
    ? [{ id: 'custom', settings: { temperature: 0.25 }, body: { max_completion_tokens: 256, incoming_flag: true } }, { id: 'new', settings: { reasoningEffort: 'medium' }, body: { max_completion_tokens: 128 } }]
    : { custom: { temperature: 0.25, max_completion_tokens: 256 }, new: { reasoningEffort: 'medium', max_completion_tokens: 128 } };
  const variants = [
    { id: 'custom', name: 'Keep label', metadata: { keep: true }, settings: { reasoningEffort: 'high', temperature: 0.123 }, body: { max_completion_tokens: 8192, custom_flag: true } },
    { id: 'absent', settings: { reasoningEffort: 'low' }, body: { untouched: true } },
  ];
  const original = structuredClone(variants);
  const config: Record<string, unknown> = { providers: { demo: { models: { one: { variants } } } }, provider: { demo: { models: { one: { variants: incoming } } } } };
  serializeOpenCodeConfigForV2(config);
  expect(config).toMatchObject({ providers: { demo: { models: { one: { variants: [
    { id: 'custom', name: 'Keep label', metadata: { keep: true }, settings: { reasoningEffort: 'high', temperature: 0.25 }, body: { max_completion_tokens: 256, custom_flag: true, ...(nativeIncoming ? { incoming_flag: true } : {}) } },
    { id: 'absent', settings: { reasoningEffort: 'low' }, body: { untouched: true } },
    { id: 'new', settings: { reasoningEffort: 'medium' }, body: { max_completion_tokens: 128 } },
  ] } } } } });
  expect(variants).toEqual(original);
});


it.each([null, [], 'invalid'])('refuses malformed native variant fields rather than replacing them with empty settings: %j', (value) => {
  for (const key of ['settings', 'body']) {
    const config: Record<string, unknown> = { providers: { demo: { models: { one: { variants: [{ id: 'custom', [key]: value }] } } } }, provider: { demo: { models: { one: { variants: { custom: { max_completion_tokens: 256 } } } } } } };
    expect(() => serializeOpenCodeConfigForV2(config)).toThrow('Unsupported native variant configuration');
  }
});
