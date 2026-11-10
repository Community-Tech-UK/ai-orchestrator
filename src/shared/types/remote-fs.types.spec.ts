import { describe, expect, it } from 'vitest';
import type { FsErrorData } from './remote-fs.types';

// Kept while James decides on code that nothing reaches: no other file uses
// FsErrorData, so this is the only place `tsc` checks it.
describe('remote-fs types', () => {
  it('FsErrorData satisfies expected shape', () => {
    const err: FsErrorData = {
      fsCode: 'EACCES',
      path: '/etc/shadow',
      retryable: false,
      suggestion: 'Check file permissions',
    };

    expect(err.fsCode).toBe('EACCES');
    expect(err.path).toBe('/etc/shadow');
    expect(err.retryable).toBe(false);
    expect(err.suggestion).toBe('Check file permissions');
  });
});
