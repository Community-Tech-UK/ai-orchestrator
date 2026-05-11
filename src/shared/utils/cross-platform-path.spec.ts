import { describe, expect, it } from 'vitest';
import {
  crossPlatformBasename,
  crossPlatformPathsEqual,
  normalizeCrossPlatformPath,
  resolveRelativePath,
} from './cross-platform-path';

describe('cross-platform-path', () => {
  describe('crossPlatformBasename', () => {
    it('handles POSIX and Windows separators', () => {
      expect(crossPlatformBasename('/home/user/project')).toBe('project');
      expect(crossPlatformBasename('C:\\Users\\alice\\project')).toBe('project');
    });
  });

  describe('normalizeCrossPlatformPath', () => {
    it('normalizes Windows paths case-insensitively', () => {
      expect(normalizeCrossPlatformPath('C:\\Users\\Alice\\Work\\My-App\\'))
        .toBe('c:/users/alice/work/my-app');
    });

    it('preserves POSIX path casing', () => {
      expect(normalizeCrossPlatformPath('/Users/Alice/Work/My-App/'))
        .toBe('/Users/Alice/Work/My-App');
    });
  });

  describe('crossPlatformPathsEqual', () => {
    it('matches equivalent Windows paths', () => {
      expect(crossPlatformPathsEqual(
        'C:\\Users\\Alice\\Work\\My-App',
        'c:/users/alice/work/my-app/',
      )).toBe(true);
    });

    it('does not collapse distinct POSIX paths by case', () => {
      expect(crossPlatformPathsEqual('/Users/Alice/Work', '/users/alice/work')).toBe(false);
    });
  });

  describe('resolveRelativePath', () => {
    it('joins a simple relative path onto a POSIX base', () => {
      expect(resolveRelativePath('/Users/me/proj', 'PLAN.md'))
        .toBe('/Users/me/proj/PLAN.md');
      expect(resolveRelativePath('/Users/me/proj', 'docs/foo.md'))
        .toBe('/Users/me/proj/docs/foo.md');
    });

    it('collapses .. segments correctly', () => {
      expect(resolveRelativePath('/Users/me/proj', '../docs/foo.md'))
        .toBe('/Users/me/docs/foo.md');
      expect(resolveRelativePath('/Users/me/proj/sub', '../../docs/foo.md'))
        .toBe('/Users/me/docs/foo.md');
    });

    it('collapses . segments', () => {
      expect(resolveRelativePath('/Users/me/proj', 'a/./b/../c.md'))
        .toBe('/Users/me/proj/a/c.md');
    });

    it('returns absolute POSIX paths unchanged', () => {
      expect(resolveRelativePath('/Users/me/proj', '/tmp/plan.md'))
        .toBe('/tmp/plan.md');
    });

    it('returns absolute Windows paths unchanged', () => {
      expect(resolveRelativePath('/Users/me/proj', 'C:\\out\\plan.md'))
        .toBe('C:\\out\\plan.md');
    });

    it('handles Windows base paths', () => {
      expect(resolveRelativePath('C:\\Users\\me\\proj', 'PLAN.md'))
        .toBe('C:\\Users\\me\\proj\\PLAN.md');
      expect(resolveRelativePath('C:\\Users\\me\\proj', '..\\docs\\foo.md'))
        .toBe('C:\\Users\\me\\docs\\foo.md');
    });

    it('does not pop past POSIX root', () => {
      expect(resolveRelativePath('/', '../../foo.md')).toBe('/foo.md');
    });

    it('returns base when relative is empty', () => {
      expect(resolveRelativePath('/Users/me/proj', '')).toBe('/Users/me/proj');
    });
  });
});
