import { describe, expect, it } from 'vitest';
import { PlanQueueQuestionSchema } from '@contracts/schemas/plan-queue';
import { isHoldNote } from './plan-queue-run-hold';
import {
  isTicketHoldNote, PlanQueueTicketHeld, ticketAskQuestion, ticketAskSentence, ticketHoldPatch, ticketUnreadableSentence,
} from './plan-queue-ticket-ask';
import { buildQuestionsMessage, parentCanAnswer } from './plan-queue-messages';
import { newPlanQueueItem } from './plan-queue-state';

describe('the words for a ticket that may not start', () => {
  it('says the same fixed sentence for each kind of question, naming only the ticket', () => {
    expect(ticketAskSentence('ORC-12', 'changed')).toBe('ORC-12 changed in Linear. Answer on the Plan Queue page.');
    expect(ticketAskSentence('ORC-12', 'gone')).toBe('ORC-12 was removed from Linear or moved out of its project. Answer on the Plan Queue page.');
    expect(ticketAskSentence('ORC-12', 'unconfirmed')).toBe('ORC-12 has no text Harness can confirm you approved. Answer on the Plan Queue page.');
  });

  it('offers three answers for a change and two for a ticket that has gone, all valid questions marked for James alone', () => {
    const changed = ticketAskQuestion('ORC-12', 'changed');
    expect(changed.options.map((option) => option.id)).toEqual(['use-now', 'keep-approved', 'stop']);
    expect(ticketAskQuestion('ORC-12', 'gone').options.map((option) => option.id)).toEqual(['stop', 'leave-waiting']);
    expect(ticketAskQuestion('ORC-12', 'unconfirmed').options.map((option) => option.id)).toEqual(['stop', 'leave-waiting']);
    for (const kind of ['changed', 'gone', 'unconfirmed'] as const) {
      const question = ticketAskQuestion('ORC-12', kind);
      expect(PlanQueueQuestionSchema.parse(question)).toEqual(question);
      expect(question.jamesOnly).toBe(true);
      expect(question.question).toBe(ticketAskSentence('ORC-12', kind));
    }
  });

  it('uses the connection\'s own sentence when it has one, and words of its own when it has not', () => {
    expect(ticketUnreadableSentence('ORC-12', 'Linear work is paused: stand-in.')).toBe('Linear work is paused: stand-in.');
    expect(ticketUnreadableSentence('ORC-12', null)).toBe('ORC-12 could not be read in Linear, so nothing was started. Harness will try again soon.');
  });

  it('recognises its own sentences as a hold note, which is a status for James and never an instruction to a worker', () => {
    for (const note of [ticketAskSentence('ORC-12', 'changed'), ticketAskSentence('COM-9', 'gone'), ticketUnreadableSentence('ORC-12', null), 'Linear work is paused: x.']) {
      expect(isTicketHoldNote(note)).toBe(true);
      expect(isHoldNote(note)).toBe(true);
    }
    for (const other of [null, undefined, '', 'Fix the footer link', 'ORC-12 changed in Linear.']) expect(isTicketHoldNote(other)).toBe(false);
  });

  it('is a refusal whose message is the sentence, with the question only when one is open', () => {
    const asked = new PlanQueueTicketHeld(ticketAskSentence('ORC-12', 'changed'), 'ORC-12', 'changed');
    expect(asked.question).toEqual(ticketAskQuestion('ORC-12', 'changed'));
    expect(ticketHoldPatch(asked)).toEqual({ detail: asked.message, question: asked.question });
    const unread = new PlanQueueTicketHeld(ticketUnreadableSentence('ORC-12', null), 'ORC-12', null);
    expect(unread.question).toBeNull();
    expect(ticketHoldPatch(unread)).toEqual({ detail: unread.message, question: null });
  });
});

describe('a question only James can answer is not given to the parent session', () => {
  const asked = (jamesOnly: boolean) => ({ ...newPlanQueueItem('item-1', 'run-1', 'linear:x', 1, { sourceKind: 'linear', state: 'queued' }),
    question: { question: 'A question?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], ...(jamesOnly ? { jamesOnly: true } : {}) } });

  it('leaves it out of the parent\'s questions and out of the message that lists them', () => {
    expect(parentCanAnswer(asked(true))).toBe(false);
    expect(parentCanAnswer(asked(false))).toBe(true);
    expect(buildQuestionsMessage([asked(true)])).not.toContain('item-1');
    expect(buildQuestionsMessage([asked(true)])).not.toContain('option_id "a"');
    expect(buildQuestionsMessage([asked(true), asked(false)])).toContain('1. A question?');
    expect(buildQuestionsMessage([asked(true), asked(false)])).toContain('on 1 document(s)');
  });
});
