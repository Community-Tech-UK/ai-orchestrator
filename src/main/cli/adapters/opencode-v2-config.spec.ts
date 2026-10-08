import { describe, expect, it } from 'vitest';
import { mirrorOpenCodeProviderForV2, normalizeOpenCodeNativeConfig } from './opencode-v2-config';
import { projectOpenCodeConfig } from './opencode-config-shapes';

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

  it('refuses variant lists that do not expose a numeric cap', () => {
    expect(() => normalizeOpenCodeNativeConfig([{ type: 'document', info: {
      providers: { demo: { models: { one: { variants: [{ id: 'high', settings: { private: true } }] } } } },
    } }])).toThrow('Unsupported native numeric limit');
  });

  it('copies the legacy provider tree to the OpenCode 2 key', () => {
    const config: Record<string, unknown> = { provider: { demo: { models: { one: { limit: { output: 128 } } } } } };
    mirrorOpenCodeProviderForV2(config);
    expect(config['providers']).toEqual(config['provider']);
  });
});
