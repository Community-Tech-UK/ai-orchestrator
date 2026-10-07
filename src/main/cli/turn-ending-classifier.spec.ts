import { describe, expect, it } from 'vitest';
import { classifyTurnEnding } from './turn-ending-classifier';

describe('turn-ending corpus', () => {
  it.each([
    ['HTTP 401 unauthorized', 'auth'], ['payment required', 'billing'],
    ['context_length_exceeded', 'context_overflow'], ['quota exceeded', 'quota'],
    ['ContentFilterError', 'content_filter'], ['doom_loop', 'doom_loop'],
    ['ACP agent exited (1)', 'crash'], ['server_error', 'retryable'], ['unrecognized failure', 'unknown_error'],
  ])('classifies %s without echoing source material into evidence', (error, reason) => {
    const result = classifyTurnEnding({ kind: 'error', error: `${error} PRIVATE_SOURCE_PLACEHOLDER` });
    expect(result.reason).toBe(reason);
    expect(result.evidence).not.toContain('PRIVATE_SOURCE_PLACEHOLDER');
    expect(result.evidence).toMatch(/^[a-z_]+$/);
  });

  it('honors native finish on old ACP end_turn and reads native Claude result fields', () => {
    expect(classifyTurnEnding({ kind: 'complete', metadata: { stopReason: 'end_turn', finish: 'length' } }).reason).toBe('max_output');
    const raw = [
      { type: 'assistant', message: { stop_reason: 'max_tokens' } },
      { type: 'assistant', parent_tool_use_id: 'child', message: { stop_reason: 'end_turn' } },
      { type: 'result', is_error: false },
    ].map((frame) => JSON.stringify(frame)).join('\n');
    expect(classifyTurnEnding({ kind: 'complete', raw }).reason).toBe('max_output');
    expect(classifyTurnEnding({ kind: 'complete', raw: JSON.stringify({ type: 'result', is_error: true, result: 'quota exceeded' }) }).reason).toBe('quota');
  });

  it.each(['finish', 'finish_reason', 'stopReason'])('recognizes MiMo repetition_truncation in %s without exposing thinking', (field) => {
    expect(classifyTurnEnding({ kind: 'complete', metadata: { [field]: 'repetition_truncation' } })).toEqual({
      reason: 'max_output', evidence: 'native_repetition_truncation', reasoningCollapsed: true,
    });
    expect(classifyTurnEnding({ kind: 'complete', metadata: { [field]: 'repetition_truncation' },
      text: 'The requested work is complete.', outputTokens: 20 })).toMatchObject({
      reason: 'max_output', visibleAnswerComplete: true, autoContinueSuppressed: true,
    });
  });

  it('marks content-filter provenance only when a read was observed', () => {
    const input = { kind: 'complete' as const, metadata: { stopReason: 'refusal' } };
    expect(classifyTurnEnding(input)).not.toHaveProperty('contentFilterFromTool');
    expect(classifyTurnEnding({ ...input, lastToolReadLike: true })).toMatchObject({ contentFilterFromTool: true });
  });

  it('suppresses collapsed thinking recovery only with a measured finished answer and no open tools', () => {
    const input = { kind: 'complete' as const, text: 'The import is complete.', outputTokens: 20, thinking: [{ content: 'Hmm. '.repeat(40) }] };
    expect(classifyTurnEnding(input)).toMatchObject({ reason: 'max_output', reasoningCollapsed: true, visibleAnswerComplete: true, autoContinueSuppressed: true });
    expect(classifyTurnEnding({ ...input, outputTokens: 0 })).not.toHaveProperty('autoContinueSuppressed');
    expect(classifyTurnEnding({ ...input, hasOpenToolCall: true })).not.toHaveProperty('autoContinueSuppressed');
    expect(classifyTurnEnding({ ...input, text: 'I will inspect the import.' })).not.toHaveProperty('autoContinueSuppressed');
  });

  it('does not mistake narration, a cancelled response, or a tool boundary for an interrupted turn', () => {
    expect(classifyTurnEnding({ kind: 'complete', text: 'I fixed the auth token expired warning.' }).reason).toBe('completed');
    expect(classifyTurnEnding({ kind: 'complete', cancelled: true, metadata: { stopReason: 'max_tokens' } })).toMatchObject({ reason: 'completed', autoContinueSuppressed: true });
    expect(classifyTurnEnding({ kind: 'complete', metadata: { stopReason: 'tool_calls' } })).toMatchObject({ reason: 'completed', autoContinueSuppressed: true });
    expect(classifyTurnEnding({ kind: 'error', metadata: { parentSilent: true } }).reason).toBe('parent_silent');
  });

  it('requires explicit turn-scoped transcript proof before recovering a dangling tool result', () => {
    expect(classifyTurnEnding({ kind: 'complete', metadata: { danglingToolResult: true } }).reason).toBe('completed');
    expect(classifyTurnEnding({ kind: 'complete', metadata: { danglingToolResult: true, toolResultAwaitingReply: true } }).reason).toBe('dangling_tool_result');
  });

  it('classifies an end_turn that saturates the injected output cap as max_output', () => {
    expect(classifyTurnEnding({
      kind: 'complete',
      text: 'two thousand seven hundred ninety',
      metadata: { stopReason: 'end_turn' },
      outputTokens: 16_229,
      reasoningTokens: 155,
      combinedOutputTokenCap: 16_384,
    })).toMatchObject({ reason: 'max_output', evidence: 'budget_saturated' });
  });

  it('keeps an end_turn well under the cap as an ordinary completion', () => {
    expect(classifyTurnEnding({
      kind: 'complete',
      text: 'The requested summary is done.',
      metadata: { stopReason: 'end_turn' },
      outputTokens: 40,
      reasoningTokens: 0,
      combinedOutputTokenCap: 16_384,
    })).toMatchObject({ reason: 'completed', evidence: 'provider_completed' });
  });

  it('classifies a Claude user-interrupt result as a client cancellation', () => {
    const raw = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Interrupted by user',
    });
    expect(classifyTurnEnding({ kind: 'complete', raw })).toEqual({
      reason: 'completed',
      evidence: 'client_cancelled',
      autoContinueSuppressed: true,
    });
  });

  it('maps native context ceilings and error codes before falling back to clean completion', () => {
    expect(classifyTurnEnding({ kind: 'complete', metadata: { stopReason: 'model_context_window_exceeded' } }).reason).toBe('context_overflow');
    expect(classifyTurnEnding({ kind: 'error', error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }).reason).toBe('truncated_transport');
    expect(classifyTurnEnding({ kind: 'complete', metadata: { stopReason: 'error' } }).reason).toBe('unknown_error');
  });
});
