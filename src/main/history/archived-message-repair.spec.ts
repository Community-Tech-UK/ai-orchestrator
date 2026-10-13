import { describe, expect, it } from 'vitest';
import type { ConversationData } from '../../shared/types/history.types';
import type { OutputMessage } from '../../shared/types/instance.types';
import { repairArchivedMessageIdentity } from './archived-message-repair';

function conversation(messages: unknown[], createdAt: number = 1_000): ConversationData {
  return {
    entry: { id: 'entry-1', createdAt } as ConversationData['entry'],
    messages: messages as OutputMessage[],
  };
}

describe('repairArchivedMessageIdentity', () => {
  it('gives a message missing its id and time a stable id and the previous time', () => {
    const data = conversation([
      { id: 'u1', type: 'user', content: 'prompt', timestamp: 5_000 },
      { type: 'system', content: 'Codex stopped retrying the provider failure. Work is preserved.' },
      { id: 'a1', type: 'assistant', content: 'answer', timestamp: 6_000 },
    ]);

    repairArchivedMessageIdentity(data);

    expect(data.messages.map((message) => [message.id, message.timestamp])).toEqual([
      ['u1', 5_000], ['entry-1:repaired:1', 5_000], ['a1', 6_000],
    ]);
  });

  it('agrees on the repaired id across loads', () => {
    const raw = [{ type: 'system', content: 'notice', timestamp: 2_000 }];
    const first = conversation(structuredClone(raw));
    const second = conversation(structuredClone(raw));

    repairArchivedMessageIdentity(first);
    repairArchivedMessageIdentity(second);

    expect(first.messages[0]?.id).toBe(second.messages[0]?.id);
  });

  it("uses the entry's start time when nothing earlier has a time", () => {
    const data = conversation([{ id: 'n1', type: 'system', content: 'notice' }], 1_234);

    repairArchivedMessageIdentity(data);

    expect(data.messages[0]?.timestamp).toBe(1_234);
  });

  it('leaves unreadable messages for the readers to reject', () => {
    const data = conversation([null, { type: 'assistant', content: 42 }, { type: 'assistant' }]);
    const before = structuredClone(data.messages);

    repairArchivedMessageIdentity(data);

    expect(data.messages).toEqual(before);
  });

  it('keeps existing ids and times untouched', () => {
    const messages = [
      { id: 'u1', type: 'user', content: 'prompt', timestamp: 5_000 },
      { id: 'a1', type: 'assistant', content: 'answer', timestamp: 4_000 },
    ];
    const data = conversation(structuredClone(messages));

    repairArchivedMessageIdentity(data);

    expect(data.messages).toEqual(messages);
  });

  it('ignores a file that is not a conversation', () => {
    expect(() => repairArchivedMessageIdentity(null)).not.toThrow();
    expect(() => repairArchivedMessageIdentity({} as ConversationData)).not.toThrow();
  });
});
