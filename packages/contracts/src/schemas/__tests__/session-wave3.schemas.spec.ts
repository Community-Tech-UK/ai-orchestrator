import { describe, expect, it } from 'vitest';

import {
  CostRecordUsagePayloadSchema,
  HistoryExpandSnippetsPayloadSchema,
  HistorySearchAdvancedPayloadSchema,
  ResumeForkNewPayloadSchema,
} from '../session.schemas';

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('Wave 3 session IPC schemas', () => {
  it('accepts advanced history search payloads', () => {
    const result = HistorySearchAdvancedPayloadSchema.safeParse({
      searchQuery: 'auth',
      snippetQuery: 'token',
      workingDirectory: '/repo',
      projectScope: 'current',
      source: ['history-transcript', 'child_result'],
      timeRange: { from: 1, to: 2 },
      page: { pageSize: 10, pageNumber: 1 },
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid history page sizes', () => {
    const result = HistorySearchAdvancedPayloadSchema.safeParse({
      page: { pageSize: 101, pageNumber: 1 },
    });

    expect(result.success).toBe(false);
  });

  it('accepts snippet expansion and fork payloads', () => {
    expect(HistoryExpandSnippetsPayloadSchema.safeParse({
      entryId: 'entry-1',
      query: 'auth',
    }).success).toBe(true);
    expect(ResumeForkNewPayloadSchema.safeParse({ entryId: 'entry-1' }).success).toBe(true);
  });

  it('accepts usage cost model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const result = CostRecordUsagePayloadSchema.safeParse({
      instanceId: 'inst-1',
      sessionId: 'session-1',
      model: maxCatalogModelId,
      inputTokens: 1,
      outputTokens: 2,
    });

    expect(result.success).toBe(true);
  });

  it('rejects usage cost model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    const result = CostRecordUsagePayloadSchema.safeParse({
      instanceId: 'inst-1',
      sessionId: 'session-1',
      model: tooLongCatalogModelId,
      inputTokens: 1,
      outputTokens: 2,
    });

    expect(result.success).toBe(false);
  });
});
