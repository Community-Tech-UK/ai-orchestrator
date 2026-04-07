import { describe, it, expect } from 'vitest';
import {
  FsReadDirectoryParamsSchema,
  FsStatParamsSchema,
  FsSearchParamsSchema,
  FsWatchParamsSchema,
  FsUnwatchParamsSchema,
} from './remote-fs-schemas';

describe('FsReadDirectoryParamsSchema', () => {
  it('accepts minimal input (just path)', () => {
    const result = FsReadDirectoryParamsSchema.safeParse({ path: '/some/dir' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.depth).toBe(1);
      expect(result.data.includeHidden).toBe(false);
      expect(result.data.limit).toBe(500);
    }
  });

  it('accepts full input', () => {
    const result = FsReadDirectoryParamsSchema.safeParse({
      path: '/some/dir',
      depth: 3,
      includeHidden: true,
      cursor: 'abc123',
      limit: 100,
    });
    expect(result.success).toBe(true);
  });

  it('rejects depth > 3', () => {
    const result = FsReadDirectoryParamsSchema.safeParse({ path: '/some/dir', depth: 4 });
    expect(result.success).toBe(false);
  });

  it('rejects empty path', () => {
    const result = FsReadDirectoryParamsSchema.safeParse({ path: '' });
    expect(result.success).toBe(false);
  });
});

describe('FsStatParamsSchema', () => {
  it('accepts a valid path', () => {
    const result = FsStatParamsSchema.safeParse({ path: '/some/file.txt' });
    expect(result.success).toBe(true);
  });
});

describe('FsSearchParamsSchema', () => {
  it('defaults maxResults to 20', () => {
    const result = FsSearchParamsSchema.safeParse({ query: 'hello' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(20);
    }
  });

  it('rejects empty query', () => {
    const result = FsSearchParamsSchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });
});

describe('FsWatchParamsSchema', () => {
  it('defaults recursive to false', () => {
    const result = FsWatchParamsSchema.safeParse({ path: '/some/dir' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recursive).toBe(false);
    }
  });
});

describe('FsUnwatchParamsSchema', () => {
  it('accepts a watchId', () => {
    const result = FsUnwatchParamsSchema.safeParse({ watchId: 'watch-abc-123' });
    expect(result.success).toBe(true);
  });
});
