import { describe, expect, it } from 'vitest';
import type { AcpSessionPromptResult } from '../../../shared/types/cli.types';
import { createAcpAssistantTurn } from './acp-assistant-stream';
import { buildAcpTurnCompletion } from './acp-turn-completion';

describe('ACP completion diagnostics', () => {
  it.each(['LOCAL_TEST_SOURCE_PLACEHOLDER', { source: 'LOCAL_TEST_SOURCE_PLACEHOLDER' }])('excludes unvalidated native stop metadata from diagnostics', (stopReason) => {
    const completion = buildAcpTurnCompletion({
      result: { stopReason, finish: 'LOCAL_TEST_SOURCE_PLACEHOLDER' } as unknown as AcpSessionPromptResult,
      turn: createAcpAssistantTurn('fixture'), toolCalls: [], adapter: 'OpenCode',
      providerUsageReported: false, usage: undefined, leaseMs: 100,
    });
    expect(JSON.stringify(completion.logFields)).not.toContain('LOCAL_TEST_SOURCE_PLACEHOLDER');
    expect(completion.logFields.finish).toBe('other');
    // Transport metadata is retained for classification, not copied into logs.
    expect(completion.response.metadata?.['stopReason']).toEqual(stopReason);
  });

  it('keeps allowlisted endings and measured usage without source material', () => {
    const turn = createAcpAssistantTurn('fixture');
    turn.chunks.push('private fixture answer');
    turn.thoughtChunksById.set('thought', ['Hmm. '.repeat(40)]);
    const completion = buildAcpTurnCompletion({
      result: { stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 3, thoughtTokens: 40, totalTokens: 44 } },
      turn, toolCalls: [{ title: 'private fixture tool', kind: 'read', status: 'pending' }], adapter: 'OpenCode',
      model: 'fixture-model', providerUsageReported: true, usage: undefined, leaseMs: 100,
    });
    expect(completion.logFields).toMatchObject({ stopReason: 'max_tokens', outputTokens: 3, reasoningTokens: 40, activeToolKind: 'read', classifierReason: 'max_output' });
    expect(completion.logFields.collapsedTailHash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(completion.logFields)).not.toContain('private fixture');
    expect(JSON.stringify(completion.logFields)).not.toContain('Hmm.');
  });

  it('filters untrusted usage, tool kinds and multiline identifiers at the same boundary', () => {
    const completion = buildAcpTurnCompletion({
      result: { stopReason: 'end_turn', usage: { outputTokens: 'LOCAL_TEST_SOURCE_PLACEHOLDER', thoughtTokens: 'LOCAL_TEST_SOURCE_PLACEHOLDER' } } as unknown as AcpSessionPromptResult,
      turn: createAcpAssistantTurn('fixture'),
      toolCalls: [{ title: 'fixture', kind: 'LOCAL_TEST_SOURCE_PLACEHOLDER', status: 'pending' }],
      adapter: 'OpenCode', model: 'fixture\nLOCAL_TEST_SOURCE_PLACEHOLDER',
      providerUsageReported: false, usage: undefined, leaseMs: 100,
    });
    expect(completion.logFields).toMatchObject({ activeToolKind: 'other', outputTokens: undefined, reasoningTokens: undefined, model: undefined });
    expect(JSON.stringify(completion.logFields)).not.toContain('LOCAL_TEST_SOURCE_PLACEHOLDER');
  });
});
