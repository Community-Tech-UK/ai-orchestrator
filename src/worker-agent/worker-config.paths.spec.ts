import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { expandHomePath, normalizeWorkingDirectories } from './worker-config';

describe('expandHomePath', () => {
  const home = path.join(path.sep, 'home', 'noah');

  it('expands a bare ~ to the home directory', () => {
    expect(expandHomePath('~', home)).toBe(home);
  });

  it('expands a ~/ prefix', () => {
    expect(expandHomePath('~/code', home)).toBe(path.join(home, 'code'));
  });

  it('expands a ~\\ (Windows-style) prefix', () => {
    expect(expandHomePath('~\\code', home)).toBe(path.join(home, 'code'));
  });

  it('leaves absolute paths untouched', () => {
    const abs = path.join(path.sep, 'srv', 'projects');
    expect(expandHomePath(abs, home)).toBe(abs);
  });

  it('does not expand a ~ that is not a leading home reference', () => {
    expect(expandHomePath('/tmp/~backup', home)).toBe('/tmp/~backup');
    // `~user` form is intentionally not expanded.
    expect(expandHomePath('~noah/code', home)).toBe('~noah/code');
  });

  it('returns empty string unchanged', () => {
    expect(expandHomePath('', home)).toBe('');
  });
});

describe('normalizeWorkingDirectories', () => {
  const home = path.join(path.sep, 'home', 'noah');

  it('expands ~ entries to absolute home paths', () => {
    expect(normalizeWorkingDirectories(['~', '~/code'], home)).toEqual([
      home,
      path.join(home, 'code'),
    ]);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(normalizeWorkingDirectories(['', '   ', '~/code'], home)).toEqual([
      path.join(home, 'code'),
    ]);
  });

  it('trims surrounding whitespace before expanding', () => {
    expect(normalizeWorkingDirectories(['  ~/code  '], home)).toEqual([
      path.join(home, 'code'),
    ]);
  });

  it('de-duplicates entries that resolve to the same path', () => {
    expect(normalizeWorkingDirectories(['~', '~', '~/code'], home)).toEqual([
      home,
      path.join(home, 'code'),
    ]);
  });

  it('returns an empty array for undefined or non-array input', () => {
    expect(normalizeWorkingDirectories(undefined, home)).toEqual([]);
    expect(normalizeWorkingDirectories([], home)).toEqual([]);
  });

  it('leaves non-tilde absolute paths as-is', () => {
    const abs = path.join(path.sep, 'srv', 'work');
    expect(normalizeWorkingDirectories([abs], home)).toEqual([abs]);
  });
});
