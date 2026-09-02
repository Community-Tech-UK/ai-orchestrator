import { describe, expect, it } from 'vitest';
import {
  appendAcpAssistantDelta,
  collectAcpAssistantFlushes,
  createAcpAssistantTurn,
  normalizeAcpAssistantDelta,
  resolveAcpChunkTurn,
} from './acp-assistant-stream';

describe('normalizeAcpAssistantDelta', () => {
  it('strips a sole trailing newline from a token chunk', () => {
    expect(normalizeAcpAssistantDelta('ix\n')).toBe('ix');
    expect(normalizeAcpAssistantDelta('ix\r\n')).toBe('ix');
  });

  it('keeps real paragraph breaks and internal newlines', () => {
    expect(normalizeAcpAssistantDelta('hello\n\n')).toBe('hello\n\n');
    expect(normalizeAcpAssistantDelta('hello\nworld\n')).toBe('hello\nworld\n');
    expect(normalizeAcpAssistantDelta('hello')).toBe('hello');
  });

  it('turns a newline-only chunk into empty text', () => {
    expect(normalizeAcpAssistantDelta('\n')).toBe('');
    expect(normalizeAcpAssistantDelta('\r\n')).toBe('');
  });
});

describe('resolveAcpChunkTurn', () => {
  it('prefers the in-flight prompt, then the settled assistant turn', () => {
    const current = createAcpAssistantTurn('current');
    const recent = createAcpAssistantTurn('recent');

    expect(resolveAcpChunkTurn(current, recent, 'agent_message_chunk')).toBe(current);
    expect(resolveAcpChunkTurn(null, recent, 'agent_message_chunk')).toBe(recent);
    expect(resolveAcpChunkTurn(null, null, 'agent_message_chunk')).toBeNull();
  });

  it('does not attach user chunks to a settled assistant turn', () => {
    const recent = createAcpAssistantTurn('recent');
    expect(resolveAcpChunkTurn(null, recent, 'user_message_chunk')).toBeNull();
  });
});

describe('appendAcpAssistantDelta + collectAcpAssistantFlushes', () => {
  it('joins token-sized deltas onto one flush id', () => {
    const turn = createAcpAssistantTurn('turn-1');
    expect(appendAcpAssistantDelta(turn, 'turn-1', 'Confirmed — f')).toBe('Confirmed — f');
    expect(appendAcpAssistantDelta(turn, 'turn-1', 'ix')).toBe('Confirmed — fix');
    expect(appendAcpAssistantDelta(turn, 'turn-1', 'ing that line now.')).toBe(
      'Confirmed — fixing that line now.',
    );
    expect(collectAcpAssistantFlushes(turn)).toEqual([
      { id: 'turn-1', content: 'Confirmed — fixing that line now.' },
    ]);
  });
});
