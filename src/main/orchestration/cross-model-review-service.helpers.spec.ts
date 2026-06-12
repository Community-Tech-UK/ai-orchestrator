import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { extractJson, resolveReviewWorkingDirectory } from './cross-model-review-service.helpers';

describe('resolveReviewWorkingDirectory', () => {
  it('returns an existing directory unchanged', () => {
    expect(resolveReviewWorkingDirectory(tmpdir())).toBe(tmpdir());
  });

  it('falls back to process.cwd() for a missing directory', () => {
    expect(resolveReviewWorkingDirectory('/definitely/not/a/real/dir')).toBe(process.cwd());
  });

  it('falls back to process.cwd() for a remote-node Windows path', () => {
    expect(resolveReviewWorkingDirectory('C:\\Users\\shutu\\Documents\\Work')).toBe(process.cwd());
  });

  it('falls back to process.cwd() when the path is a plain file', () => {
    expect(resolveReviewWorkingDirectory(join(process.cwd(), 'package.json'))).toBe(process.cwd());
  });

  it('falls back to process.cwd() when undefined', () => {
    expect(resolveReviewWorkingDirectory(undefined)).toBe(process.cwd());
  });
});

describe('extractJson (sanity)', () => {
  it('still parses fenced reviewer JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});
