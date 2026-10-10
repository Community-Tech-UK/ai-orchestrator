import { describe, expect, it } from 'vitest';
import {
  applyOpenCodeAccountProviderBlocks,
  buildOpenCodeAccountProviderBlocks,
  buildOpenCodeModelConfigEntry,
  openCodeAccountFallbackBaseUrl,
  openCodeAccountProviderDef,
  parseOpenCodeModelMetadataBlocks,
  resolveOpenCodeSessionModel,
  type OpenCodeModelMetadataBlock,
} from './opencode-account-provider-config';

// Shape captured from `opencode models xiaomi-token-plan-ams --verbose`
// (OpenCode 1.18.35); values are placeholders, never real credentials.
const VERBOSE_FIXTURE = `xiaomi-token-plan-ams/mimo-v2.6-pro
{
  "id": "mimo-v2.6-pro",
  "api": {
    "id": "mimo-v2.6-pro",
    "npm": "@ai-sdk/openai-compatible",
    "url": "https://token-plan-ams.xiaomimimo.com/v1"
  },
  "status": "active",
  "name": "MiMo-V2.6-Pro",
  "providerID": "xiaomi-token-plan-ams",
  "capabilities": {
    "temperature": true,
    "reasoning": true,
    "attachment": true,
    "toolcall": true,
    "input": { "text": true, "audio": true, "image": true, "video": true, "pdf": false },
    "output": { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
    "interleaved": { "field": "reasoning_content" }
  },
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "options": { "max_completion_tokens": 16384 },
  "limit": { "context": 1000000, "output": 16384 },
  "headers": {},
  "family": "mimo",
  "release_date": "2026-09-22",
  "variants": {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" }
  }
}
xiaomi-token-plan-ams/mimo-v2-tts
{
  "id": "mimo-v2-tts",
  "name": "MiMo-V2-TTS",
  "capabilities": { "toolcall": false, "output": { "audio": true, "text": false } }
}
not-a-header line
{ broken json`;

const region = (blocks: OpenCodeModelMetadataBlock[]) => () => blocks;

describe('parseOpenCodeModelMetadataBlocks', () => {
  it('reads provider/model headers with their metadata JSON and skips broken blocks', () => {
    const blocks = parseOpenCodeModelMetadataBlocks(VERBOSE_FIXTURE);
    expect(blocks.map((block) => [block.providerId, block.modelId])).toEqual([
      ['xiaomi-token-plan-ams', 'mimo-v2.6-pro'],
      ['xiaomi-token-plan-ams', 'mimo-v2-tts'],
    ]);
    expect(blocks[0]!.metadata['limit']).toEqual({ context: 1000000, output: 16384 });
    expect(blocks[0]!.metadata['providerID']).toBe('xiaomi-token-plan-ams');
  });
});

describe('resolveOpenCodeSessionModel regional account targets', () => {
  describe.each(['xiaomi-token-plan', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn'])(
    'logical provider %s', (logicalProvider) => {
      it.each(['xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn'])(
        'selects the derived legacy target %s while keeping the model suffix', (target) => {
          expect(resolveOpenCodeSessionModel(`${logicalProvider}/mimo-v2.6-pro`, target))
            .toBe(`${target}/mimo-v2.6-pro`);
        },
      );
    },
  );

  it.each(['xiaomi-token-plan', 'xiaomi-token-plan-eu', 'xiaomi-token-plan-ams-extra',
    'xiaomi-token-planning-ams', 'xiaomi-token-plan-sgp/model', 'openrouter'])(
    'does not treat look-alike or unrelated target %s as a legacy account', (target) => {
      expect(resolveOpenCodeSessionModel('xiaomi-token-plan-ams/mimo-v2.6-pro', target))
        .toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    },
  );

  it.each(['opencode/mimo-v2.6-flash-free', 'openrouter/example-model', 'aio-mimo-account-a/mimo-v2.6-pro',
    'xiaomi-token-planning/mimo-v2.6-pro', 'xiaomi-token-plan-eu/mimo-v2.6-pro'])(
    'keeps non-logical native model %s on its own provider', (model) => {
      expect(resolveOpenCodeSessionModel(model, 'xiaomi-token-plan-sgp')).toBe(model);
    },
  );

  it.each([undefined, '', 'auto', ' AUTO '])('omits native/default model %s', (model) => {
    expect(resolveOpenCodeSessionModel(model, 'xiaomi-token-plan-sgp')).toBeUndefined();
  });

  it.each([undefined, null, ''])('preserves the logical model when route is %s', (target) => {
    expect(resolveOpenCodeSessionModel('xiaomi-token-plan-ams/mimo-v2.6-pro', target))
      .toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
  });
});

describe('buildOpenCodeModelConfigEntry', () => {
  it('restores the built-in model metadata, including interleaved reasoning and effort variants', () => {
    const [pro] = parseOpenCodeModelMetadataBlocks(VERBOSE_FIXTURE);
    const entry = buildOpenCodeModelConfigEntry(pro!.metadata);
    expect(entry).toMatchObject({
      name: 'MiMo-V2.6-Pro',
      limit: { context: 1000000, output: 16384 },
      options: { max_completion_tokens: 16384 },
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      interleaved: { field: 'reasoning_content' },
      modalities: { input: ['text', 'audio', 'image', 'video'], output: ['text'] },
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
      },
    });
  });

  it('copies no credential-looking model options', () => {
    const entry = buildOpenCodeModelConfigEntry({
      options: { max_completion_tokens: 16384, apiKey: 'PLACEHOLDER-VALUE', auth_token: 'PLACEHOLDER-VALUE' },
      capabilities: {},
    });
    expect(entry['options']).toEqual({ max_completion_tokens: 16384 });
    expect(JSON.stringify(entry)).not.toContain('PLACEHOLDER-VALUE');
  });
});

describe('buildOpenCodeAccountProviderBlocks', () => {
  const def = openCodeAccountProviderDef({ id: 'max-b-1a2b', label: 'MiMo B', isLegacy: false, region: 'ams' });

  it('derives the provider name and copies base URL, npm and models from the region metadata', () => {
    const meta = parseOpenCodeModelMetadataBlocks(VERBOSE_FIXTURE);
    const { blocks, missingRegions } = buildOpenCodeAccountProviderBlocks([def], region(meta));
    expect(missingRegions).toEqual([]);
    const provider = blocks['aio-mimo-max-b-1a2b'] as Record<string, unknown>;
    expect(provider).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'MiMo B',
      options: { baseURL: 'https://token-plan-ams.xiaomimimo.com/v1' },
    });
    // No key material is ever injected; OpenCode's own key store supplies it.
    expect(JSON.stringify(provider)).not.toContain('apiKey');
    expect(Object.keys(provider['models'] as object)).toEqual(['mimo-v2.6-pro', 'mimo-v2-tts']);
  });

  it('reports regions whose metadata cannot be read and builds no block for them', () => {
    const { blocks, missingRegions } = buildOpenCodeAccountProviderBlocks([def], () => null);
    expect(blocks).toEqual({});
    expect(missingRegions).toEqual(['ams']);
  });

  it('falls back to the documented region base URL when metadata carries none', () => {
    const meta = parseOpenCodeModelMetadataBlocks(
      'xiaomi-token-plan-ams/mimo-v2.6-pro\n' + JSON.stringify({ id: 'mimo-v2.6-pro', name: 'MiMo' }),
    );
    const { blocks } = buildOpenCodeAccountProviderBlocks([def], region(meta));
    const provider = blocks['aio-mimo-max-b-1a2b'] as Record<string, unknown>;
    expect(provider['npm']).toBe('@ai-sdk/openai-compatible');
    expect((provider['options'] as Record<string, unknown>)['baseURL']).toBe(openCodeAccountFallbackBaseUrl('ams'));
  });
});

describe('applyOpenCodeAccountProviderBlocks', () => {
  it('merges AIO-managed providers without touching the rest of the config', () => {
    const config: Record<string, unknown> = {
      permission: { '*': 'allow' },
      provider: { 'fake-x': { npm: '@ai-sdk/openai-compatible' } },
    };
    applyOpenCodeAccountProviderBlocks(config, { 'aio-mimo-max-b-1a2b': { npm: '@ai-sdk/openai-compatible' } });
    expect(Object.keys(config['provider'] as object).sort()).toEqual(['aio-mimo-max-b-1a2b', 'fake-x']);
    expect(config['permission']).toEqual({ '*': 'allow' });
  });

  it('is a no-op with no blocks (legacy-only stays byte-identical)', () => {
    const config: Record<string, unknown> = { permission: { '*': 'allow' } };
    applyOpenCodeAccountProviderBlocks(config, {});
    expect(config).toEqual({ permission: { '*': 'allow' } });
  });
});
