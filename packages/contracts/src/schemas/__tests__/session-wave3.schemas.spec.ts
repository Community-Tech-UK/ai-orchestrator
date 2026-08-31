import { describe, expect, it } from 'vitest';

import {
  CostRecordUsagePayloadSchema,
  HistoryExpandSnippetsPayloadSchema,
  HistorySearchAdvancedPayloadSchema,
  ResumeForkNewPayloadSchema,
} from '../session.schemas';
import * as sessionSchemas from '../session.schemas';

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

function recoveryCandidateFixture(index: number): Record<string, unknown> {
  const suffix = String(index).padStart(3, '0');
  return {
    recoveryKey: `history:claude:thread-${suffix}`,
    sourceInstanceId: `source-${suffix}`,
    historyThreadId: `thread-${suffix}`,
    provider: 'claude',
    modelId: 'opus',
    displayName: `Recovered fixture ${suffix}`,
    workingDirectory: '/repo',
    lastActivityAt: 1_775_024_000_000 - index,
    historyCoveredThrough: 1_775_023_000_000 - index,
    recoveredMessageCount: 3,
    reason: 'newer-than-history',
    nativeResumeAvailable: true,
  };
}

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

  it('accepts only the public autosave recovery candidate list shape', () => {
    const schema = (sessionSchemas as Record<string, unknown>)['SessionRecoveryListResultSchema'] as
      | { safeParse(value: unknown): { success: boolean; data?: unknown } }
      | undefined;
    expect(schema).toBeDefined();
    if (!schema) return;

    const candidate = {
      recoveryKey: 'history:claude:thread-1',
      sourceInstanceId: 'source-1',
      historyThreadId: 'thread-1',
      provider: 'claude',
      modelId: 'opus',
      displayName: 'Recovered fixture',
      workingDirectory: '/repo',
      lastActivityAt: 1_775_024_000_000,
      historyCoveredThrough: 1_775_023_000_000,
      recoveredMessageCount: 3,
      reason: 'newer-than-history',
      nativeResumeAvailable: true,
    };

    expect(schema.safeParse([]).success).toBe(true);
    const parsed = schema.safeParse([candidate]);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual([candidate]);

    expect(schema.safeParse([{
      ...candidate,
      resumeCursor: { threadId: 'cursor-secret' },
    }]).success).toBe(false);
    expect(schema.safeParse([{
      ...candidate,
      transcript: [{ content: 'private transcript text' }],
    }]).success).toBe(false);
    expect(schema.safeParse([{
      ...candidate,
      recoveryAliases: ['session:claude:secret'],
    }]).success).toBe(false);
  });

  it('accepts shutdown-live-preserved recovery lists beyond the non-live cap while validating each candidate', () => {
    const schema = (sessionSchemas as Record<string, unknown>)['SessionRecoveryListResultSchema'] as
      | { safeParse(value: unknown): { success: boolean; data?: unknown } }
      | undefined;
    expect(schema).toBeDefined();
    if (!schema) return;

    const candidates = [
      ...Array.from({ length: 50 }, (_, index) => recoveryCandidateFixture(index)),
      {
        ...recoveryCandidateFixture(50),
        recoveryKey: 'history:claude:thread-shutdown-live',
        sourceInstanceId: 'shutdown-live',
        historyThreadId: 'thread-shutdown-live',
        displayName: 'Preserved shutdown-live fixture',
      },
    ];

    expect(candidates).toHaveLength(51);
    const parsed = schema.safeParse(candidates);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(candidates);
    expect(schema.safeParse([
      ...candidates.slice(0, -1),
      {
        ...candidates.at(-1),
        resumeCursor: { threadId: 'redacted-cursor-placeholder' },
      },
    ]).success).toBe(false);
  });

  it('validates autosave recovery restore requests and results without private fields', () => {
    const requestSchema = (sessionSchemas as Record<string, unknown>)['RecoverSessionRequestSchema'] as
      | { safeParse(value: unknown): { success: boolean; data?: unknown } }
      | undefined;
    const resultSchema = (sessionSchemas as Record<string, unknown>)['RecoverSessionResultSchema'] as
      | { safeParse(value: unknown): { success: boolean; data?: unknown } }
      | undefined;
    expect(requestSchema).toBeDefined();
    expect(resultSchema).toBeDefined();
    if (!requestSchema || !resultSchema) return;

    expect(requestSchema.safeParse({ recoveryKey: 'history:claude:thread-1' }).success).toBe(true);
    expect(requestSchema.safeParse({ recoveryKey: '' }).success).toBe(false);
    expect(requestSchema.safeParse({
      recoveryKey: 'history:claude:thread-1',
      providerCursor: 'cursor-secret',
    }).success).toBe(false);

    const result = {
      instanceId: 'replacement-1',
      recoveredMessageCount: 3,
      usedNativeResume: false,
    };
    expect(resultSchema.safeParse(result).data).toEqual(result);
    expect(resultSchema.safeParse({
      ...result,
      transcript: [{ content: 'private transcript text' }],
    }).success).toBe(false);
    expect(resultSchema.safeParse({
      ...result,
      resumeCursor: 'cursor-secret',
    }).success).toBe(false);
  });
});
