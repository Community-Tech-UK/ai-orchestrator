import { describe, expect, it } from 'vitest';

import {
  HistoryExpandSnippetsPayloadSchema,
  HistorySearchAdvancedPayloadSchema,
  ResumeForkNewPayloadSchema,
} from '../session.schemas';

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
});
