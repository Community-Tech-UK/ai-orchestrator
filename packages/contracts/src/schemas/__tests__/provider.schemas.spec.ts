import { describe, expect, it } from 'vitest';
import {
  LLMCountTokensPayloadSchema,
  LLMSetConfigPayloadSchema,
  LLMTruncateTokensPayloadSchema,
  ModelsCLIPushPayloadSchema,
  ModelsLocalReviewerQualifyPayloadSchema,
} from '../provider.schemas';

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('provider LLM payload schemas', () => {
  it('accepts model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(LLMCountTokensPayloadSchema.safeParse({
      text: 'hello',
      model: maxCatalogModelId,
    }).success).toBe(true);
    expect(LLMTruncateTokensPayloadSchema.safeParse({
      text: 'hello',
      maxTokens: 10,
      model: maxCatalogModelId,
    }).success).toBe(true);
    expect(LLMSetConfigPayloadSchema.safeParse({
      model: maxCatalogModelId,
    }).success).toBe(true);
  });

  it('rejects model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(LLMCountTokensPayloadSchema.safeParse({
      text: 'hello',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
    expect(LLMTruncateTokensPayloadSchema.safeParse({
      text: 'hello',
      maxTokens: 10,
      model: tooLongCatalogModelId,
    }).success).toBe(false);
    expect(LLMSetConfigPayloadSchema.safeParse({
      model: tooLongCatalogModelId,
    }).success).toBe(false);
  });
});

describe('ModelsLocalReviewerQualifyPayloadSchema', () => {
  it('accepts only a bounded local-model selector', () => {
    expect(ModelsLocalReviewerQualifyPayloadSchema.safeParse({
      selectorId: 'lm://this-device/ollama/ollama/qwen',
      ipcAuthToken: 'token',
    }).success).toBe(true);
    expect(ModelsLocalReviewerQualifyPayloadSchema.safeParse({ selectorId: 'qwen' }).success)
      .toBe(false);
    expect(ModelsLocalReviewerQualifyPayloadSchema.safeParse({
      selectorId: `lm://${'x'.repeat(4_096)}`,
    }).success).toBe(false);
    expect(ModelsLocalReviewerQualifyPayloadSchema.safeParse({
      selectorId: 'lm://this-device/ollama/ollama/qwen', extra: true,
    }).success).toBe(false);
  });
});

describe('ModelsCLIPushPayloadSchema', () => {
  it('accepts CLI-discovered model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(ModelsCLIPushPayloadSchema.safeParse({
      provider: 'cursor',
      models: [{
        id: maxCatalogModelId,
        name: 'Long dynamic model',
        tier: 'balanced',
      }],
    }).success).toBe(true);
  });

  it('rejects CLI-discovered model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(ModelsCLIPushPayloadSchema.safeParse({
      provider: 'cursor',
      models: [{
        id: tooLongCatalogModelId,
        name: 'Too long dynamic model',
        tier: 'balanced',
      }],
    }).success).toBe(false);
  });

  it('accepts CLI-discovered display names up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(ModelsCLIPushPayloadSchema.safeParse({
      provider: 'copilot',
      models: [{
        id: 'gpt-long-name',
        name: maxCatalogModelId,
        tier: 'balanced',
      }],
    }).success).toBe(true);
  });
});

describe('CLI check and scan payload schemas', () => {
  it('accepts the bare CLI type string cli:check sends', async () => {
    const { CliCheckPayloadSchema } = await import('../provider.schemas');
    expect(CliCheckPayloadSchema.parse('claude')).toBe('claude');
    expect(CliCheckPayloadSchema.safeParse('').success).toBe(false);
    expect(CliCheckPayloadSchema.safeParse({ type: 'claude' }).success).toBe(false);
    expect(CliCheckPayloadSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('accepts { type } and a bare string for cli:scan-all-installs', async () => {
    const { CliScanAllInstallsPayloadSchema } = await import('../provider.schemas');
    expect(CliScanAllInstallsPayloadSchema.parse({ type: 'codex' })).toEqual({ type: 'codex' });
    expect(CliScanAllInstallsPayloadSchema.parse('codex')).toBe('codex');
    expect(CliScanAllInstallsPayloadSchema.safeParse({}).success).toBe(false);
    expect(CliScanAllInstallsPayloadSchema.safeParse(42).success).toBe(false);
  });
});

