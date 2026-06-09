import { describe, it, expect } from 'vitest';
import { parseAskUserQuestions, buildAskUserQuestionPrompt } from './ask-user-question-prompt';

describe('parseAskUserQuestions', () => {
  it('parses the real nested questions[] schema with options', () => {
    const entries = parseAskUserQuestions({
      questions: [
        {
          header: 'Posts',
          question: 'Which posts should I comment on?',
          multiSelect: true,
          options: [
            { label: 'Robyn Ball', description: 'genuine confusion' },
            { label: 'Janet Pearce', description: 'real question' },
          ],
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      header: 'Posts',
      question: 'Which posts should I comment on?',
      multiSelect: true,
    });
    expect(entries[0].options).toEqual([
      { label: 'Robyn Ball', description: 'genuine confusion' },
      { label: 'Janet Pearce', description: 'real question' },
    ]);
  });

  it('parses multiple questions', () => {
    const entries = parseAskUserQuestions({
      questions: [
        { header: 'Posts', question: 'Which posts?', options: [{ label: 'Robyn' }] },
        { header: 'Flow', question: 'Which flow?', options: [{ label: 'Approve each' }] },
      ],
    });

    expect(entries.map((e) => e.question)).toEqual(['Which posts?', 'Which flow?']);
    expect(entries.every((e) => e.multiSelect === false)).toBe(true);
  });

  it('handles the flat single-question shape', () => {
    const entries = parseAskUserQuestions({
      question: 'Tabs or sections?',
      options: ['Tabs', 'Sections'],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].question).toBe('Tabs or sections?');
    expect(entries[0].options).toEqual([{ label: 'Tabs' }, { label: 'Sections' }]);
  });

  it('drops options without a usable label', () => {
    const entries = parseAskUserQuestions({
      questions: [{ question: 'Pick one', options: [{ description: 'no label' }, { label: 'Valid' }] }],
    });

    expect(entries[0].options).toEqual([{ label: 'Valid' }]);
  });

  it('returns an empty array for non-object / empty input', () => {
    expect(parseAskUserQuestions(undefined)).toEqual([]);
    expect(parseAskUserQuestions(null)).toEqual([]);
    expect(parseAskUserQuestions('nope')).toEqual([]);
    expect(parseAskUserQuestions({})).toEqual([]);
  });

  it('stays consistent with the text prompt builder', () => {
    const input = {
      questions: [{ header: 'Flow', question: 'Which flow?', options: [{ label: 'Approve each' }] }],
    };
    const prompt = buildAskUserQuestionPrompt(input);
    const entries = parseAskUserQuestions(input);
    expect(prompt).toContain(entries[0].question);
    expect(prompt).toContain(entries[0].options[0].label);
  });
});
