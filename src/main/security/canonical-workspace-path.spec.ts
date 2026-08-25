import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalizeWorkspacePath,
  isPathWithin,
  pathSegmentDepth,
} from './canonical-workspace-path';

let root = '';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-path-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('canonicalizeWorkspacePath', () => {
  it('resolves relative traversal segments', () => {
    expect(canonicalizeWorkspacePath('/a/b/../c', { platform: 'linux' })).toBe('/a/c');
  });

  it('resolves a symlinked workspace to its target', () => {
    const target = join(root, 'real-work');
    mkdirSync(target, { recursive: true });
    const link = join(root, 'linked-work');
    symlinkSync(target, link, 'dir');

    expect(canonicalizeWorkspacePath(link, { platform: 'linux' })).toBe(target);
  });

  it('folds case on darwin and win32 but not on linux', () => {
    expect(canonicalizeWorkspacePath('/Users/Me/Work', { platform: 'darwin' })).toBe(
      '/users/me/work',
    );
    expect(canonicalizeWorkspacePath('/Users/Me/Work', { platform: 'linux' })).toBe(
      '/Users/Me/Work',
    );
    // win32 folds too; `resolve`'s separator style is the host platform's, so
    // assert only the case behaviour here.
    const win32 = canonicalizeWorkspacePath('/Users/Me/Work', { platform: 'win32' });
    expect(win32).toBe(win32.toLowerCase());
  });

  it('still resolves a path that does not exist', () => {
    expect(canonicalizeWorkspacePath('/definitely/not/here/../there', { platform: 'linux' })).toBe(
      '/definitely/not/there',
    );
  });

  it('returns empty for empty input', () => {
    expect(canonicalizeWorkspacePath('')).toBe('');
  });
});

describe('isPathWithin', () => {
  it('rejects a sibling sharing a string prefix', () => {
    expect(isPathWithin('/a/bc', '/a/b')).toBe(false);
  });

  it('accepts the parent itself and any descendant', () => {
    expect(isPathWithin('/a/b', '/a/b')).toBe(true);
    expect(isPathWithin('/a/b/c/d', '/a/b')).toBe(true);
  });

  it('rejects empty operands', () => {
    expect(isPathWithin('', '/a')).toBe(false);
    expect(isPathWithin('/a', '')).toBe(false);
  });
});

describe('pathSegmentDepth', () => {
  it('counts segments so a deeper rule wins over a longer string', () => {
    expect(pathSegmentDepth('/a/b/c')).toBe(3);
    expect(pathSegmentDepth('/a/bbbbbbbb')).toBe(2);
    expect(pathSegmentDepth('/')).toBe(0);
  });
});
