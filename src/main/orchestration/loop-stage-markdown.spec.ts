import { describe, expect, it } from 'vitest';
import {
  parseOutstandingSections,
  outstandingHasHumanItems,
  isPlanLikeMarkdown,
} from './loop-stage-markdown';

describe('parseOutstandingSections', () => {
  it('extracts needs-human and open-question bullets under their headings', () => {
    const raw = [
      '# Outstanding',
      '',
      '## Needs human',
      '- Deploy to a physical device and confirm the camera works.',
      '- Run on a machine with a GPU.',
      '',
      '## Open questions',
      '- Should the model be cached between runs?',
      '- What timeout is acceptable?',
    ].join('\n');

    const result = parseOutstandingSections(raw);
    expect(result.needsHuman).toEqual([
      'Deploy to a physical device and confirm the camera works.',
      'Run on a machine with a GPU.',
    ]);
    expect(result.openQuestions).toEqual([
      'Should the model be cached between runs?',
      'What timeout is acceptable?',
    ]);
  });

  it('treats placeholder bullets as empty sections', () => {
    const raw = '## Needs human\n- (none)\n\n## Open questions\n- n/a';
    const result = parseOutstandingSections(raw);
    expect(result.needsHuman).toEqual([]);
    expect(result.openQuestions).toEqual([]);
  });

  it('recognises heading synonyms and strips checkboxes + emphasis', () => {
    const raw = [
      '### Requires human review',
      '- [ ] **Sign the release** with the prod key',
      '## Unresolved questions',
      '1. Is `feature-x` in scope?',
    ].join('\n');
    const result = parseOutstandingSections(raw);
    expect(result.needsHuman).toEqual(['Sign the release with the prod key']);
    expect(result.openQuestions).toEqual(['Is feature-x in scope?']);
  });

  it('ignores bullets outside of recognised sections', () => {
    const raw = '## Summary\n- not an outstanding item\n## Needs human\n- a real one';
    const result = parseOutstandingSections(raw);
    expect(result.needsHuman).toEqual(['a real one']);
    expect(result.openQuestions).toEqual([]);
  });

  it('returns empty sections for blank input', () => {
    expect(parseOutstandingSections('')).toEqual({ needsHuman: [], openQuestions: [] });
    expect(parseOutstandingSections('   \n  ')).toEqual({ needsHuman: [], openQuestions: [] });
  });
});

describe('isPlanLikeMarkdown — exported OUTSTANDING.md guard', () => {
  it('does not treat the consolidated OUTSTANDING.md digest as a plan doc', () => {
    // Regression: the export writes `- [ ]` checkboxes at the workspace root;
    // without the denylist entry a future loop would demand it be renamed.
    expect(isPlanLikeMarkdown('OUTSTANDING.md')).toBe(false);
    expect(isPlanLikeMarkdown('outstanding.md')).toBe(false);
  });

  it('still treats genuine plan files as plan-like', () => {
    expect(isPlanLikeMarkdown('feature-plan.md')).toBe(true);
  });
});

describe('outstandingHasHumanItems (delegates to parser)', () => {
  it('is true only when the needs-human section has a real item', () => {
    expect(outstandingHasHumanItems('## Needs human\n- real item')).toBe(true);
    expect(outstandingHasHumanItems('## Needs human\n- (none)')).toBe(false);
    expect(outstandingHasHumanItems('## Open questions\n- only a question')).toBe(false);
    expect(outstandingHasHumanItems('')).toBe(false);
  });
});
