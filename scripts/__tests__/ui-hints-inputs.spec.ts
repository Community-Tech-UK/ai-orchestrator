import { describe, expect, it } from 'vitest';
import { analyze } from '../ui-hints/analyze';
import { checkLedger, recordNew } from '../ui-hints/wording-ledger.js';
import { fixtureTree } from './ui-hints-fixtures';
import { avoidWordReports } from '../ui-hints/glossary-report';
import { AVOID_WORD_PATTERNS } from '../../src/shared/glossary/glossary';

describe('component input copy and visible warnings', () => {
  it.each([
    'subtitle="Selected instance"',
    '[subtitle]="\'Selected instance\'"',
    'subtitle="Selected {{ \'instance\' }}"',
    '[subtitle]="ready ? \'Selected instance\' : \'Selected session\'"',
    'aria-label="Selected instance"',
  ])('checks vocabulary in %s even when it cannot prove visible rendering', attribute => {
    const tree = fixtureTree(`<app-child ${attribute}></app-child>`);
    try {
      const analysis = analyze(tree.root, {});
      expect(avoidWordReports(analysis.vocabularyStreams, AVOID_WORD_PATTERNS).join(' ')).toContain('avoid word "instance"');
    } finally { tree.cleanup(); }
  });
  it.each(['aria-label', 'aria-description', 'data-details', 'unusedInput'])(
    'does not let %s replace a visible consequence', attribute => {
      const tree = fixtureTree('<button appTooltip="Delete all conversation history">Delete</button>');
      try {
        const ledger = recordNew(analyze(tree.root, {}), []);
        tree.write(`<button ${attribute}="Delete all conversation history">Delete</button>`);
        expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('H9 hover wording lost');
      } finally { tree.cleanup(); }
    },
  );
});
