import { describe, expect, it } from 'vitest';
import { mergeComposerRestoreText } from './composer-restore-text';

describe('mergeComposerRestoreText', () => {
  it('prepends a cancelled queued message by default, preserving both texts verbatim', () => {
    expect(mergeComposerRestoreText(' queued\nmessage ', ' current\ndraft '))
      .toBe(' queued\nmessage \n\n current\ndraft ');
  });

  it('appends table selections after the existing draft', () => {
    expect(mergeComposerRestoreText('Rows 1 and 3', 'Draft', 'append')).toBe('Draft\n\nRows 1 and 3');
  });

  it.each(['prepend', 'append'] as const)('does not add separators for empty text (%s)', (placement) => {
    expect(mergeComposerRestoreText('', 'Draft', placement)).toBe('Draft');
    expect(mergeComposerRestoreText('Restored', '', placement)).toBe('Restored');
    expect(mergeComposerRestoreText('', '', placement)).toBe('');
  });
});
