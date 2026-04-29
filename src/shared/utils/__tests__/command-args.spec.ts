import { describe, expect, it } from 'vitest';
import { parseArgsFromQuery } from '../command-args';

describe('parseArgsFromQuery', () => {
  it('returns no args for an empty query', () => {
    expect(parseArgsFromQuery('')).toEqual([]);
  });

  it('parses args after the command token', () => {
    expect(parseArgsFromQuery('/review staged changes')).toEqual(['staged', 'changes']);
  });

  it('parses args after a supplied alias', () => {
    expect(parseArgsFromQuery('/r "auth flow"', 'r')).toEqual(['auth flow']);
  });

  it('preserves quoted values and escaped characters', () => {
    expect(parseArgsFromQuery('/fix "login bug" path\\ with\\ spaces')).toEqual([
      'login bug',
      'path with spaces',
    ]);
  });
});
