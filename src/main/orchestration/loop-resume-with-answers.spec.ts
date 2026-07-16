import { describe, expect, it } from 'vitest';
import type { LoopOutstandingItem } from '../../shared/types/loop.types';
import { buildResumeWithAnswersPrompt } from './loop-resume-with-answers';

function item(overrides: Partial<LoopOutstandingItem> = {}): LoopOutstandingItem {
  return {
    id: 'id-1',
    loopRunId: 'loop-1',
    chatId: 'chat-1',
    workspaceCwd: '/tmp/project',
    kind: 'needs-human',
    text: 'Pick the interrupt mechanism',
    userResponse: null,
    recommendedAnswer: null,
    status: 'open',
    loopStatus: 'completed-needs-review',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    resolvedAt: null,
    ...overrides,
  };
}

describe('buildResumeWithAnswersPrompt', () => {
  it('throws when there are no answered items', () => {
    expect(() => buildResumeWithAnswersPrompt({ answered: [], unanswered: [] })).toThrow(/at least one/i);
  });

  it('renders answered items as numbered decisions', () => {
    const prompt = buildResumeWithAnswersPrompt({
      answered: [
        item({ id: 'a', text: 'Pick the interrupt mechanism', userResponse: 'Use control_request' }),
        item({ id: 'b', kind: 'open-question', text: 'Cache the model?', userResponse: 'Yes, 30m TTL' }),
      ],
      unanswered: [],
    });

    expect(prompt).toContain('## Decisions to apply');
    expect(prompt).toContain('1. [Needs human] Pick the interrupt mechanism');
    expect(prompt).toContain('Decision: Use control_request');
    expect(prompt).toContain('2. [Open question] Cache the model?');
    expect(prompt).toContain('Decision: Yes, 30m TTL');
    // No "still unanswered" section when everything is answered.
    expect(prompt).not.toContain('## Still unanswered');
    expect(prompt).toContain('## What to do now');
  });

  it('lists unanswered items separately and pins the original goal', () => {
    const prompt = buildResumeWithAnswersPrompt({
      answered: [item({ id: 'a', text: 'Decided thing', userResponse: 'Do X' })],
      unanswered: [item({ id: 'c', text: 'Undecided thing', userResponse: null })],
      originalGoal: 'Ship the reliability fixes',
    });

    expect(prompt).toContain('## Original goal');
    expect(prompt).toContain('Ship the reliability fixes');
    expect(prompt).toContain('## Still unanswered');
    expect(prompt).toContain('- [Needs human] Undecided thing');
    // The unanswered item is listed as a plain bullet with no Decision line.
    const unansweredSection = prompt.split('## Still unanswered')[1] ?? '';
    expect(unansweredSection).not.toContain('Decision:');
  });

  it('indents multi-line answers under the decision', () => {
    const prompt = buildResumeWithAnswersPrompt({
      answered: [item({ id: 'a', text: 'Multi', userResponse: 'Line one\nLine two' })],
      unanswered: [],
    });
    expect(prompt).toContain('  Decision: Line one\n  Line two');
  });
});
