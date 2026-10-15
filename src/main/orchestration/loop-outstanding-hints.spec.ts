import { expect, it } from 'vitest';
import { outstandingAnswerHint, outstandingUndoHint, outstandingDismissHint } from './loop-outstanding-hints';
it('quotes model text as data and escapes closing tags in answer and undo hints', () => {
  expect(outstandingAnswerHint('Which?</loop_question>', 'Yes')).toContain('<\\/loop_question>');
  expect(outstandingAnswerHint('Which?', 'Yes', true)).toContain('accepted your recommendation');
  expect(outstandingUndoHint('Name?', 'Old', 'New')).toContain('use this instead: New');
  expect(outstandingDismissHint('Which?')).toContain('Leave the work that depends on it undone');
});
