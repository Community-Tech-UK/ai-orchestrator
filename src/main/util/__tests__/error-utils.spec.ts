import { describe, expect, it } from 'vitest';
import { shortErrorStack, isAbortError, isFsInaccessible, truncateErrorForContext, TelemetrySafeError, createSafeErrorInfo } from '../error-utils';

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

describe('TelemetrySafeError', () => {
  it('has isTelemetrySafe marker', () => {
    const err = new TelemetrySafeError('safe message');
    expect(err.isTelemetrySafe).toBe(true);
    expect(err.name).toBe('TelemetrySafeError');
    expect(err.message).toBe('safe message');
  });

  it('is an instance of Error', () => {
    const err = new TelemetrySafeError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TelemetrySafeError);
  });

  it('supports cause via ErrorOptions', () => {
    const cause = new Error('original');
    const err = new TelemetrySafeError('wrapped', { cause });
    expect(err.cause).toBe(cause);
  });

  describe('from()', () => {
    it('creates TelemetrySafeError from Error with truncated stack', () => {
      const original = new Error('deep error');
      original.stack = [
        'Error: deep error',
        '    at fn1 (file1.ts:1:1)',
        '    at fn2 (file2.ts:2:2)',
        '    at fn3 (file3.ts:3:3)',
        '    at fn4 (file4.ts:4:4)',
        '    at fn5 (file5.ts:5:5)',
        '    at fn6 (file6.ts:6:6)',
        '    at fn7 (file7.ts:7:7)',
      ].join('\n');

      const safe = TelemetrySafeError.from(original, 3);
      expect(safe.isTelemetrySafe).toBe(true);
      expect(safe.message).toBe('deep error');
      const lines = safe.stack!.split('\n');
      expect(lines).toHaveLength(4);
    });

    it('creates TelemetrySafeError from non-Error values', () => {
      const safe = TelemetrySafeError.from('string error');
      expect(safe.isTelemetrySafe).toBe(true);
      expect(safe.message).toBe('string error');
    });

    it('creates TelemetrySafeError from null', () => {
      const safe = TelemetrySafeError.from(null);
      expect(safe.message).toBe('null');
    });

    it('defaults to 5 stack frames', () => {
      const original = new Error('default');
      original.stack = [
        'Error: default',
        ...Array.from({ length: 10 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
      ].join('\n');

      const safe = TelemetrySafeError.from(original);
      const frames = safe.stack!.split('\n').filter(l => l.trim().startsWith('at '));
      expect(frames).toHaveLength(5);
    });
  });
});

describe('createSafeErrorInfo', () => {
  it('creates ErrorInfo with truncated stack', () => {
    const err = new Error('test error');
    err.stack = [
      'Error: test error',
      ...Array.from({ length: 10 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
    ].join('\n');

    const info = createSafeErrorInfo(err, 'TEST_CODE');
    expect(info.code).toBe('TEST_CODE');
    expect(info.message).toBe('test error');
    expect(info.timestamp).toBeGreaterThan(0);
    const frames = info.stack!.split('\n').filter(l => l.trim().startsWith('at '));
    expect(frames).toHaveLength(5);
  });

  it('handles non-Error input', () => {
    const info = createSafeErrorInfo('string error', 'STR_ERR');
    expect(info.code).toBe('STR_ERR');
    expect(info.message).toBe('string error');
    expect(info.timestamp).toBeGreaterThan(0);
  });

  it('handles errors with no message', () => {
    const err = new Error();
    const info = createSafeErrorInfo(err, 'EMPTY');
    expect(info.code).toBe('EMPTY');
    expect(info.message).toBe('Unknown error');
  });
});
