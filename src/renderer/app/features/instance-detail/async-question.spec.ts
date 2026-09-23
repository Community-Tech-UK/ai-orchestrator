import { describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import {
  asyncAnswerDelivery,
  chatAsyncAnswerTarget,
  asyncQuestionSubagent,
  formatAsyncAnswer,
  isAsyncAnswerTo,
  isAsyncQuestionMessage,
  parseAsyncQuestions,
} from './async-question';

function message(partial: Partial<OutputMessage> = {}): OutputMessage {
  return {
    id: 'q1',
    timestamp: 1,
    type: 'assistant',
    content: 'Keep writes blocked?',
    metadata: { asyncUserInput: true, questions: [{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }] },
    ...partial,
  } as OutputMessage;
}

describe('async-question', () => {
  it('recognises only assistant messages flagged as async questions', () => {
    expect(isAsyncQuestionMessage(message())).toBe(true);
    expect(isAsyncQuestionMessage(message({ metadata: {} }))).toBe(false);
    expect(isAsyncQuestionMessage(message({ type: 'user' }))).toBe(false);
  });

  it('parses questions and drops malformed entries and blank options', () => {
    const parsed = parseAsyncQuestions(message({
      metadata: {
        asyncUserInput: true,
        questions: [
          { title: ' First? ', options: ['A', '', 7, 'B'] },
          { title: 'Free text?', options: null },
          { title: '' },
          'junk',
          null,
        ],
      },
    }));
    expect(parsed).toEqual([
      { title: 'First?', options: ['A', 'B'] },
      { title: 'Free text?', options: [] },
    ]);
    expect(parseAsyncQuestions(message({ metadata: { asyncUserInput: true } }))).toEqual([]);
  });

  it('pairs each answer with its question', () => {
    expect(formatAsyncAnswer([{ title: 'Keep writes blocked?', options: [] }], ['Yes'])).toBe(
      'Answer to your question:\n\nQ: Keep writes blocked?\nA: Yes',
    );
    expect(formatAsyncAnswer(
      [{ title: 'One?', options: [] }, { title: 'Two?', options: [] }],
      ['a', ' b '],
    )).toBe('Answers to your questions:\n\nQ: One?\nA: a\n\nQ: Two?\nA: b');
  });

  it('addresses a subagent answer so the root session relays it', () => {
    expect(asyncQuestionSubagent(message({ metadata: { subagentLabel: '/root/reviewer' } }))).toBe('/root/reviewer');
    expect(asyncQuestionSubagent(message())).toBeNull();
    expect(formatAsyncAnswer([{ title: 'Branch?', options: [] }], ['main'], '/root/reviewer')).toBe(
      'Answer for subagent /root/reviewer, please pass it on:\n\nQ: Branch?\nA: main',
    );
  });

  it('reports delivery only for this question\'s own reply', () => {
    const question = message();
    const questions = parseAsyncQuestions(question);
    const reply = formatAsyncAnswer(questions, ['Yes']);
    const user = (id: string, content: string) => ({ id, timestamp: 2, type: 'user', content }) as OutputMessage;

    expect(asyncAnswerDelivery(question, questions, [question], [])).toBeNull();
    // An unrelated follow-up must not hide a question that is still open.
    expect(asyncAnswerDelivery(question, questions, [question, user('u1', 'also check module X')], [])).toBeNull();
    expect(asyncAnswerDelivery(question, questions, [question], ['also check module X'])).toBeNull();
    expect(asyncAnswerDelivery(question, questions, [question, user('u1', reply)], [])).toBe('sent');
    expect(asyncAnswerDelivery(question, questions, [question], [reply])).toBe('queued');
    // A reply to an identical earlier question sits before this one.
    expect(asyncAnswerDelivery(question, questions, [user('u0', reply), question], [])).toBeNull();
  });

  it('keeps a repeated question\'s reply with the occurrence it answers', () => {
    const first = message({ id: 'q1' });
    const second = message({ id: 'q2', timestamp: 5 });
    const questions = parseAsyncQuestions(first);
    const reply = formatAsyncAnswer(questions, ['Yes']);
    const answerToSecond = { id: 'u2', timestamp: 6, type: 'user', content: reply } as OutputMessage;

    expect(asyncAnswerDelivery(first, questions, [first, second, answerToSecond], [])).toBeNull();
    expect(asyncAnswerDelivery(second, questions, [first, second, answerToSecond], [])).toBe('sent');
    // A queued reply belongs to the latest occurrence.
    expect(asyncAnswerDelivery(first, questions, [first, second], [reply])).toBeNull();
    expect(asyncAnswerDelivery(second, questions, [first, second], [reply])).toBe('queued');
  });

  it('builds a chat target that sends through the chat service and reports failures', async () => {
    expect(chatAsyncAnswerTarget(undefined, 'inst-1', vi.fn(), vi.fn())).toBeNull();
    expect(chatAsyncAnswerTarget('chat-1', undefined, vi.fn(), vi.fn())).toBeNull();

    const sendMessageTo = vi.fn(async () => ({ ok: false as const, error: 'Chat is busy' }));
    const reportError = vi.fn();
    const target = chatAsyncAnswerTarget('chat-1', 'inst-1', sendMessageTo, reportError)!;
    expect(target.instanceId).toBe('inst-1');
    await target.send('Answer to your question:\n\nQ: X?\nA: Y');
    expect(sendMessageTo).toHaveBeenCalledWith('chat-1', 'Answer to your question:\n\nQ: X?\nA: Y');
    expect(reportError).toHaveBeenCalledWith('Chat is busy');

    sendMessageTo.mockResolvedValueOnce({ ok: true } as never);
    reportError.mockClear();
    await target.send('again');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('matches a reply only when it covers every question asked', () => {
    const questions = [{ title: 'One?', options: [] }, { title: 'Two?', options: [] }];
    expect(isAsyncAnswerTo(formatAsyncAnswer(questions, ['a', 'b']), questions)).toBe(true);
    expect(isAsyncAnswerTo(formatAsyncAnswer([questions[0]], ['a']), questions)).toBe(false);
    expect(isAsyncAnswerTo('One? Two?', questions)).toBe(false);
    expect(isAsyncAnswerTo('anything', [])).toBe(false);
  });
});
