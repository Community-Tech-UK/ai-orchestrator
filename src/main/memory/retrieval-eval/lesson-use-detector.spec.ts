import { describe, expect, it } from 'vitest';
import { detectUsedLessons } from './lesson-use-detector';

const surfaced = [
  { id: 'lesson-mutex', text: 'Acquire the session mutex before writing provider identity or you self-deadlock' },
  { id: 'lesson-tests', text: 'Run the quiet test runner for full suites to avoid context compaction' },
  { id: 'lesson-grep', text: 'macOS grep treats backslash-pipe literally; alternation greps return nothing' },
];

describe('detectUsedLessons', () => {
  it('credits a lesson whose content is echoed in the iteration text', () => {
    const text = 'I acquired the session mutex before writing the provider identity, avoiding the deadlock.';
    expect(detectUsedLessons(text, surfaced)).toEqual(['lesson-mutex']);
  });

  it('credits an explicit lesson-id mention regardless of wording', () => {
    expect(detectUsedLessons('applied lesson-grep to verify the negative', surfaced)).toContain('lesson-grep');
  });

  it('does not credit unrelated text (no false positives)', () => {
    const text = 'Refactored the CSS grid and updated the button hover states.';
    expect(detectUsedLessons(text, surfaced)).toEqual([]);
  });

  it('can credit multiple lessons in one pass', () => {
    const text =
      'Used the quiet test runner for full suites, and acquired the session mutex before writing provider identity.';
    expect(detectUsedLessons(text, surfaced).sort()).toEqual(['lesson-mutex', 'lesson-tests']);
  });

  it('returns nothing for empty text or empty lesson set', () => {
    expect(detectUsedLessons('', surfaced)).toEqual([]);
    expect(detectUsedLessons('anything', [])).toEqual([]);
  });
});
