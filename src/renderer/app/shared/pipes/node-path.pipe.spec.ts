import { describe, expect, it } from 'vitest';
import { NodePathPipe } from './node-path.pipe';

describe('NodePathPipe', () => {
  const pipe = new NodePathPipe();

  it('formats Windows paths with backslashes', () => {
    expect(pipe.transform('C:/Users/dev/projects', 'win32')).toBe('C:\\Users\\dev\\projects');
  });

  it('preserves POSIX paths for darwin', () => {
    expect(pipe.transform('/Users/suas/work', 'darwin')).toBe('/Users/suas/work');
  });

  it('preserves POSIX paths for linux', () => {
    expect(pipe.transform('/home/dev/projects', 'linux')).toBe('/home/dev/projects');
  });

  it('returns empty string for null/undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(pipe.transform(null as any, 'darwin')).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(pipe.transform(undefined as any, 'win32')).toBe('');
  });

  it('does not apply tilde shortening for Windows paths', () => {
    expect(pipe.transform('C:\\Users\\dev\\projects', 'win32')).toBe('C:\\Users\\dev\\projects');
  });
});
