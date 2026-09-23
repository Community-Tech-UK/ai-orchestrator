import { describe, expect, it } from 'vitest';
import { createAcpAssistantTurn } from './acp-assistant-stream';
import { appendAcpThoughtDelta, buildAcpTurnThinking } from './acp-thought-stream';

describe('acp thought stream', () => {
  it('groups deltas by messageId into ordered thinking blocks', () => {
    const turn = createAcpAssistantTurn('resp-1');
    appendAcpThoughtDelta(turn, 'msg-a', 'The user wants ');
    appendAcpThoughtDelta(turn, 'msg-a', 'the file.');
    appendAcpThoughtDelta(turn, 'msg-b', 'Found it.');
    expect(buildAcpTurnThinking(turn)).toEqual([
      { id: 'resp-1-thought-0', content: 'The user wants the file.', format: 'sdk' },
      { id: 'resp-1-thought-1', content: 'Found it.', format: 'sdk' },
    ]);
  });

  it('never touches assistant text', () => {
    const turn = createAcpAssistantTurn('resp-1');
    appendAcpThoughtDelta(turn, undefined, 'secret reasoning');
    expect(turn.chunks).toEqual([]);
    expect(turn.messageChunksById.size).toBe(0);
  });

  it('returns undefined when there is no non-blank thinking', () => {
    const turn = createAcpAssistantTurn('resp-1');
    expect(buildAcpTurnThinking(turn)).toBeUndefined();
    appendAcpThoughtDelta(turn, 'm', '   ');
    appendAcpThoughtDelta(turn, 'm', '');
    expect(buildAcpTurnThinking(turn)).toBeUndefined();
  });
});
