import { describe, expect, it } from 'vitest';
import { shortErrorStack, isAbortError, isFsInaccessible, truncateErrorForContext } from '../error-utils';

describe('shortErrorStack', () => {
  it('returns string representation of non-Error values', () => {
    expect(shortErrorStack('oops')).toBe('oops');
    expect(shortErrorStack(42)).toBe('42');
    expect(shortErrorStack(null)).toBe('null');
  });

  it('returns full stack when frames <= maxFrames', () => {
    const err = new Error('short');
    const result = shortErrorStack(err, 5);
    expect(result).toContain('short');
    expect(result).toContain('at ');
  });

  it('truncates stack to maxFrames', () => {
    const err = new Error('deep');
    err.stack = [
      'Error: deep',
      '    at fn1 (file1.ts:1:1)',
      '    at fn2 (file2.ts:2:2)',
      '    at fn3 (file3.ts:3:3)',
      '    at fn4 (file4.ts:4:4)',
      '    at fn5 (file5.ts:5:5)',
      '    at fn6 (file6.ts:6:6)',
      '    at fn7 (file7.ts:7:7)',
    ].join('\n');

    const result = shortErrorStack(err, 3);
    const lines = result.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('Error: deep');
    expect(lines[3]).toContain('fn3');
  });

  it('defaults to 5 frames', () => {
    const err = new Error('default');
    err.stack = [
      'Error: default',
      ...Array.from({ length: 10 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
    ].join('\n');

    const result = shortErrorStack(err);
    const frames = result.split('\n').filter(l => l.trim().startsWith('at '));
    expect(frames).toHaveLength(5);
  });

  it('handles Error with no stack', () => {
    const err = new Error('no-stack');
    err.stack = undefined;
    expect(shortErrorStack(err)).toBe('no-stack');
  });
});

describe('isAbortError', () => {
  it('detects native AbortError by name', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('detects Error with name set to AbortError', () => {
    const err = new Error('cancelled');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('detects AbortController signal reason', () => {
    const ac = new AbortController();
    ac.abort();
    expect(isAbortError(ac.signal.reason)).toBe(true);
  });

  it('returns false for regular errors', () => {
    expect(isAbortError(new Error('nope'))).toBe(false);
    expect(isAbortError(new TypeError('nope'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });
});

describe('isFsInaccessible', () => {
  function makeErrno(code: string): NodeJS.ErrnoException {
    const err = new Error(`${code}: operation failed`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it('returns true for ENOENT', () => {
    expect(isFsInaccessible(makeErrno('ENOENT'))).toBe(true);
  });

  it('returns true for EACCES', () => {
    expect(isFsInaccessible(makeErrno('EACCES'))).toBe(true);
  });

  it('returns true for EPERM', () => {
    expect(isFsInaccessible(makeErrno('EPERM'))).toBe(true);
  });

  it('returns true for ENOTDIR', () => {
    expect(isFsInaccessible(makeErrno('ENOTDIR'))).toBe(true);
  });

  it('returns true for ELOOP', () => {
    expect(isFsInaccessible(makeErrno('ELOOP'))).toBe(true);
  });

  it('returns false for other errno codes', () => {
    expect(isFsInaccessible(makeErrno('EEXIST'))).toBe(false);
    expect(isFsInaccessible(makeErrno('EISDIR'))).toBe(false);
  });

  it('returns false for non-errno errors', () => {
    expect(isFsInaccessible(new Error('not fs'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isFsInaccessible(null)).toBe(false);
    expect(isFsInaccessible('ENOENT')).toBe(false);
  });
});

describe('truncateErrorForContext', () => {
  it('returns short error messages unchanged', () => {
    const result = truncateErrorForContext(new Error('short'));
    expect(result).toContain('short');
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('truncates long errors to maxChars', () => {
    const err = new Error('x'.repeat(1000));
    err.stack = [
      `Error: ${'x'.repeat(1000)}`,
      ...Array.from({ length: 20 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
    ].join('\n');

    const result = truncateErrorForContext(err, 200);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('handles non-Error values', () => {
    expect(truncateErrorForContext('string error')).toBe('string error');
    expect(truncateErrorForContext(42)).toBe('42');
    expect(truncateErrorForContext(null)).toBe('null');
  });

  it('defaults to 500 chars', () => {
    const err = new Error('y'.repeat(2000));
    const result = truncateErrorForContext(err);
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
