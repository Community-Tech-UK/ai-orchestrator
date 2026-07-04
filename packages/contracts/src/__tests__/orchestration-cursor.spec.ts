import { describe, it, expect } from 'vitest';
import {
  DebateStartPayloadSchema,
  SpawnChildPayloadSchema,
  ConsensusProviderSpecSchema,
} from '../schemas/orchestration.schemas';

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('SpawnChildPayloadSchema — cursor', () => {
  it('accepts provider: cursor', () => {
    const result = SpawnChildPayloadSchema.safeParse({
      parentInstanceId: 'i-abc',
      task: 'hi',
      provider: 'cursor',
    });
    expect(result.success).toBe(true);
  });

  it('accepts child model overrides up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const result = SpawnChildPayloadSchema.safeParse({
      parentInstanceId: 'i-abc',
      task: 'hi',
      provider: 'claude',
      model: maxCatalogModelId,
    });

    expect(result.success).toBe(true);
  });

  it('rejects child model overrides beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    const result = SpawnChildPayloadSchema.safeParse({
      parentInstanceId: 'i-abc',
      task: 'hi',
      provider: 'claude',
      model: tooLongCatalogModelId,
    });

    expect(result.success).toBe(false);
  });
});

describe('ConsensusProviderSpecSchema — cursor', () => {
  it('accepts provider: cursor', () => {
    expect(ConsensusProviderSpecSchema.safeParse({ provider: 'cursor' }).success).toBe(true);
  });

  it('accepts consensus model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(ConsensusProviderSpecSchema.safeParse({
      provider: 'claude',
      model: maxCatalogModelId,
    }).success).toBe(true);
  });

  it('rejects consensus model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(ConsensusProviderSpecSchema.safeParse({
      provider: 'claude',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
  });
});

describe('DebateStartPayloadSchema synthesis model', () => {
  it('accepts synthesis model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(DebateStartPayloadSchema.safeParse({
      query: 'Compare approaches',
      config: {
        synthesisModel: maxCatalogModelId,
      },
    }).success).toBe(true);
  });

  it('rejects synthesis model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(DebateStartPayloadSchema.safeParse({
      query: 'Compare approaches',
      config: {
        synthesisModel: tooLongCatalogModelId,
      },
    }).success).toBe(false);
  });
});
