import { describe, expect, it } from 'vitest';
import {
  crossPlatformBasename,
  crossPlatformPathsEqual,
  normalizeCrossPlatformPath,
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
});
