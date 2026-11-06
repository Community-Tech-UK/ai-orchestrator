import { computed } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { AskAnswerDrafts } from './user-input-request.ask-drafts';
import type { UserActionRequest } from './user-action-request.types';

type Entry = NonNullable<UserActionRequest['askQuestions']>[number];

const single = (label: string, ...labels: string[]): Entry => ({
  header: 'Flow',
  question: `Which ${label}?`,
  multiSelect: false,
  options: labels.map((value) => ({ label: value })),
});
const multi = (header: string, ...labels: string[]): Entry => ({
  header,
  question: `Pick ${header}`,
  multiSelect: true,
  options: labels.map((value) => ({ label: value })),
});
const free = (header: string): Entry => ({ header, question: `Say ${header}`, multiSelect: false, options: [] });

function card(askQuestions: Entry[], transport?: string): UserActionRequest {
  return {
    id: 'req-1',
    instanceId: 'inst-1',
    requestType: 'input_required',
    title: 'Agent has a question',
    message: 'Please answer.',
    createdAt: 1,
    askQuestions,
    permissionMetadata: { type: 'ask_user_question', transport },
  };
}

describe('AskAnswerDrafts card buttons', () => {
  it('lets a single-select question hold one choice, replaced by the next click', () => {
    const drafts = new AskAnswerDrafts();
    drafts.toggle('req-1', 0, 'A', false);
    drafts.toggle('req-1', 0, 'B', false);
    expect(drafts.isPicked('req-1', 0, 'A')).toBe(false);
    expect(drafts.isPicked('req-1', 0, 'B')).toBe(true);
    drafts.toggle('req-1', 0, 'B', false);
    expect(drafts.isPicked('req-1', 0, 'B')).toBe(false);
  });

  it('lets a multi-select question hold several and toggle each off', () => {
    const drafts = new AskAnswerDrafts();
    drafts.toggle('req-1', 0, 'A', true);
    drafts.toggle('req-1', 0, 'B', true);
    drafts.toggle('req-1', 0, 'A', true);
    expect(drafts.isPicked('req-1', 0, 'A')).toBe(false);
    expect(drafts.isPicked('req-1', 0, 'B')).toBe(true);
  });

  it('is only ready once every question has a choice or some text', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([single('flow', 'Approve each', 'Autonomous'), free('notes')]);
    expect(drafts.canSubmit(request)).toBe(false);
    drafts.toggle('req-1', 0, 'Autonomous', false);
    expect(drafts.canSubmit(request)).toBe(false);
    drafts.setText('req-1', 1, '   ');
    expect(drafts.canSubmit(request)).toBe(false);
    drafts.setText('req-1', 1, 'go slowly');
    expect(drafts.canSubmit(request)).toBe(true);
  });

  it('writes the reply as one "Heading: answer" line per question', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([multi('Posts', 'Robyn Ball', 'Janet Pearce'), free('Notes')]);
    drafts.toggle('req-1', 0, 'Robyn Ball', true);
    drafts.toggle('req-1', 0, 'Janet Pearce', true);
    drafts.setText('req-1', 1, ' be kind ');
    expect(drafts.responseText(request)).toBe('Posts: Robyn Ball, Janet Pearce\nNotes: be kind');
  });

  it('writes an ACP reply as JSON keyed by the form fields', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([single('manager', 'Bun', 'NPM'), multi('tags', 'a', 'b')], 'acp');
    request.askQuestions![0].header = 'manager';
    drafts.toggle('req-1', 0, 'Bun', false);
    drafts.toggle('req-1', 1, 'a', true);
    drafts.toggle('req-1', 1, 'b', true);
    expect(JSON.parse(drafts.responseText(request))).toEqual({ manager: 'Bun', tags: ['a', 'b'] });
  });

  it('forgets a request once it is cleared', () => {
    const drafts = new AskAnswerDrafts();
    drafts.toggle('req-1', 0, 'A', false);
    drafts.clear('req-1');
    expect(drafts.isPicked('req-1', 0, 'A')).toBe(false);
  });
});

describe('AskAnswerDrafts typed answers', () => {
  it('picks the choice whose label the text equals, ignoring case and spacing', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([single('flow', 'Approve each', 'Autonomous')]);
    expect(drafts.apply(request, '  autonomous ')).toEqual({ index: 0, complete: true, remaining: 0, as: 'choice' });
    expect(drafts.isPicked('req-1', 0, 'Autonomous')).toBe(true);
    expect(drafts.responseText(request)).toBe('Flow: Autonomous');
  });

  it('keeps any other text as the typed answer to that question', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([single('flow', 'Approve each', 'Autonomous')]);
    expect(drafts.apply(request, 'Neither, ask me later')).toEqual({ index: 0, complete: true, remaining: 0, as: 'typed' });
    expect(drafts.isPicked('req-1', 0, 'Approve each')).toBe(false);
    expect(drafts.responseText(request)).toBe('Flow: Neither, ask me later');
  });

  it('lets a typed answer replace an earlier click on the same question', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([single('flow', 'Approve each', 'Autonomous')]);
    drafts.toggle('req-1', 0, 'Autonomous', false);
    drafts.apply(request, 'Something else');
    expect(drafts.isPicked('req-1', 0, 'Autonomous')).toBe(false);
    expect(drafts.responseText(request)).toBe('Flow: Something else');
  });

  it('puts text straight into a free-text question', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([free('notes')]);
    expect(drafts.apply(request, 'be kind')).toEqual({ index: 0, complete: true, remaining: 0, as: 'typed' });
    expect(drafts.text('req-1', 0)).toBe('be kind');
  });

  it('ignores empty text', () => {
    const drafts = new AskAnswerDrafts();
    expect(drafts.apply(card([free('notes')]), '   ')).toBeUndefined();
  });

  it('adds to a multi-select instead of toggling an earlier choice off', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([multi('Posts', 'Robyn Ball', 'Janet Pearce')]);
    drafts.toggle('req-1', 0, 'Robyn Ball', true);
    drafts.apply(request, 'Robyn Ball');
    expect(drafts.isPicked('req-1', 0, 'Robyn Ball')).toBe(true);
    drafts.apply(request, 'Janet Pearce');
    expect(drafts.responseText(request)).toBe('Posts: Robyn Ball, Janet Pearce');
  });

  it('reads a list of labels as several choices for a multi-select', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([multi('Posts', 'Robyn Ball', 'Janet Pearce', 'Sam')]);
    expect(drafts.apply(request, 'janet pearce, Sam')?.as).toBe('choice');
    expect(drafts.responseText(request)).toBe('Posts: Janet Pearce, Sam');
  });

  it('does not split a list for a single-select, where it is one typed answer', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([single('flow', 'Approve each', 'Autonomous')]);
    expect(drafts.apply(request, 'Approve each, Autonomous')?.as).toBe('typed');
  });

  describe('with several questions', () => {
    it('answers one question at a time and says how many are left', () => {
      const drafts = new AskAnswerDrafts();
      const request = card([single('first', 'Yes', 'No'), free('why'), single('third', 'Red', 'Blue')]);
      expect(drafts.apply(request, 'yes')).toEqual({ index: 0, complete: false, remaining: 2, as: 'choice' });
      expect(drafts.canSubmit(request)).toBe(false);
      expect(drafts.apply(request, 'because it is fast')).toEqual({ index: 1, complete: false, remaining: 1, as: 'typed' });
      expect(drafts.apply(request, 'blue')).toEqual({ index: 2, complete: true, remaining: 0, as: 'choice' });
      expect(drafts.responseText(request)).toBe('Flow: Yes\nwhy: because it is fast\nFlow: Blue');
    });

    it('prefers a matching choice over the first open free-text question', () => {
      const drafts = new AskAnswerDrafts();
      const request = card([free('branch'), single('env', 'staging', 'prod')]);
      expect(drafts.apply(request, 'prod')).toEqual({ index: 1, complete: false, remaining: 1, as: 'choice' });
      expect(drafts.text('req-1', 0)).toBe('');
      expect(drafts.apply(request, 'feature-x')).toEqual({ index: 0, complete: true, remaining: 0, as: 'typed' });
    });

    it('sends typed text to the first open question when no choice matches', () => {
      const drafts = new AskAnswerDrafts();
      const request = card([single('first', 'Yes', 'No'), single('second', 'Red', 'Blue')]);
      drafts.toggle('req-1', 0, 'No', false);
      expect(drafts.apply(request, 'Green')).toEqual({ index: 1, complete: true, remaining: 0, as: 'typed' });
      expect(drafts.responseText(request)).toContain('Flow: Green');
    });

    it('replaces the last answer when every question already has one', () => {
      const drafts = new AskAnswerDrafts();
      const request = card([single('first', 'Yes', 'No'), single('second', 'Red', 'Blue')]);
      drafts.toggle('req-1', 0, 'No', false);
      drafts.toggle('req-1', 1, 'Red', false);
      expect(drafts.apply(request, 'blue')).toEqual({ index: 1, complete: true, remaining: 0, as: 'choice' });
      expect(drafts.isPicked('req-1', 1, 'Blue')).toBe(true);
      expect(drafts.isPicked('req-1', 1, 'Red')).toBe(false);
    });
  });

  it('works on plain orchestrator questions with no choices', () => {
    const drafts = new AskAnswerDrafts();
    const request: UserActionRequest = {
      id: 'req-2',
      instanceId: 'inst-1',
      requestType: 'ask_questions',
      title: 'Questions',
      message: 'Please answer.',
      createdAt: 1,
      questions: ['Name?', 'Colour?'],
    };
    expect(drafts.apply(request, 'Ada')).toEqual({ index: 0, complete: false, remaining: 1, as: 'typed' });
    expect(drafts.apply(request, 'green')).toEqual({ index: 1, complete: true, remaining: 0, as: 'typed' });
    expect(drafts.text('req-2', 0)).toBe('Ada');
  });

  it('summarises just the answers, for the receipt', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([multi('Posts', 'Robyn Ball', 'Janet Pearce'), free('Notes')]);
    drafts.apply(request, 'Robyn Ball, Janet Pearce');
    drafts.apply(request, 'be kind');
    expect(drafts.summary(request)).toBe('Robyn Ball, Janet Pearce; be kind');
  });

  it('tells a template that reads it that something changed', () => {
    const drafts = new AskAnswerDrafts();
    const request = card([single('flow', 'A', 'B')]);
    const picked = computed(() => drafts.isPicked('req-1', 0, 'A'));
    expect(picked()).toBe(false);
    drafts.apply(request, 'A');
    expect(picked()).toBe(true);
  });
});
