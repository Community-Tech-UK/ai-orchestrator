import { describe, expect, it } from 'vitest';
import {
  PromptHistoryClearInstancePayloadSchema,
  PromptHistoryEntrySchema,
  PromptHistoryRecordPayloadSchema,
} from '../prompt-history.schemas';

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('PromptHistoryEntrySchema', () => {
  it('accepts the minimal entry shape', () => {
    const result = PromptHistoryEntrySchema.safeParse({ id: 'entry-1', text: 'hello', createdAt: 1 });

    expect(result.success).toBe(true);
  });

  it('accepts optional context fields', () => {
    const result = PromptHistoryEntrySchema.safeParse({
      id: 'entry-1',
      text: '/review',
      createdAt: 1,
      projectPath: '/tmp/project',
      provider: 'claude',
      model: 'sonnet',
      wasSlashCommand: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const result = PromptHistoryEntrySchema.safeParse({
      id: 'entry-1',
      text: '/review',
      createdAt: 1,
      provider: 'claude',
      model: maxCatalogModelId,
    });

    expect(result.success).toBe(true);
  });

  it('rejects model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    const result = PromptHistoryEntrySchema.safeParse({
      id: 'entry-1',
      text: '/review',
      createdAt: 1,
      provider: 'claude',
      model: tooLongCatalogModelId,
    });

    expect(result.success).toBe(false);
  });

  it('rejects negative timestamps and empty prompt text', () => {
    expect(PromptHistoryEntrySchema.safeParse({ id: 'entry-1', text: 'hi', createdAt: -1 }).success).toBe(false);
    expect(PromptHistoryEntrySchema.safeParse({ id: 'entry-1', text: '', createdAt: 1 }).success).toBe(false);
  });
});

describe('PromptHistoryRecordPayloadSchema', () => {
  it('accepts a record payload', () => {
    const result = PromptHistoryRecordPayloadSchema.safeParse({
      instanceId: 'inst-1',
      entry: { id: 'entry-1', text: 'hello', createdAt: 1 },
    });

    expect(result.success).toBe(true);
  });
});

describe('PromptHistoryClearInstancePayloadSchema', () => {
  it('rejects empty instance ids', () => {
    const result = PromptHistoryClearInstancePayloadSchema.safeParse({ instanceId: '' });

    expect(result.success).toBe(false);
  });
});
