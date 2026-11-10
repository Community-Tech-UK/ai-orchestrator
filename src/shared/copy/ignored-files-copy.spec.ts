import { describe, expect, it } from 'vitest';
import { IGNORED_FILES_UNCHECKED_REASON, ignoredFilesReason, isIgnoredFilesReason } from './ignored-files-copy';

describe('ignoredFilesReason', () => {
  const ending = ', which Git would replace without asking if this goes ahead.';

  it('names one file', () => {
    expect(ignoredFilesReason(['notes.md']))
      .toBe(`The main folder has a file Git ignores at notes.md${ending} Move it out of the way.`);
  });

  it('names one folder', () => {
    expect(ignoredFilesReason(['cache/']))
      .toBe(`The main folder has files Git ignores in cache/${ending} Move them out of the way.`);
  });

  it('names several places', () => {
    expect(ignoredFilesReason(['a', 'b/', 'c']))
      .toBe(`The main folder has files Git ignores at a, b/ and c${ending} Move them out of the way.`);
  });

  it('names five places, counts the rest and says where they are all listed', () => {
    expect(ignoredFilesReason(['a', 'b', 'c', 'd', 'e', 'f', 'g']))
      .toBe(`The main folder has files Git ignores at a, b, c, d, e and 2 more${ending}`
        + ' Move them out of the way; the Harness log lists them all.');
  });
});

describe('isIgnoredFilesReason', () => {
  it.each([
    [['notes.md']],
    [['cache/']],
    [['a', 'b/', 'c']],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    [['documents/plans/x/evidence, final/run 1.json']],
  ])('recognises the reason for %j', (places) => {
    expect(isIgnoredFilesReason(ignoredFilesReason(places))).toBe(true);
  });

  it('recognises the reason for a check that could not run', () => {
    expect(IGNORED_FILES_UNCHECKED_REASON).toBe('Harness could not check the main folder for files Git ignores, so nothing'
      + ' was merged. The Harness log says why.');
    expect(isIgnoredFilesReason(IGNORED_FILES_UNCHECKED_REASON)).toBe(true);
  });

  it.each([
    ['an absolute path first', ignoredFilesReason(['/Users/someone/x'])],
    ['an absolute path later in the list', ignoredFilesReason(['a.txt', '/Users/someone/x'])],
    ['an absolute path last', ignoredFilesReason(['a.txt', 'b.txt', '/Users/someone/x'])],
    ['a line break', ignoredFilesReason(['a.txt\nfatal: something'])],
    ['other text', 'fatal: could not read /Users/james/private/repo/.git/worktrees/task'],
  ])('rejects %s', (_label, reason) => {
    expect(isIgnoredFilesReason(reason)).toBe(false);
  });
});
