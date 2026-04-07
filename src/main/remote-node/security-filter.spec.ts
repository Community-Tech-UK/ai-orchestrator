import { describe, expect, it } from 'vitest';
import { SecurityFilter } from './security-filter';

describe('SecurityFilter', () => {
  describe('isRestricted', () => {
    it('flags .env files', () => {
      expect(SecurityFilter.isRestricted('.env')).toBe(true);
    });

    it('flags .env.local', () => {
      expect(SecurityFilter.isRestricted('.env.local')).toBe(true);
    });

    it('flags .env.production', () => {
      expect(SecurityFilter.isRestricted('.env.production')).toBe(true);
    });

    it('flags .ssh directory', () => {
      expect(SecurityFilter.isRestricted('.ssh')).toBe(true);
    });

    it('flags id_rsa', () => {
      expect(SecurityFilter.isRestricted('id_rsa')).toBe(true);
    });

    it('flags id_ed25519', () => {
      expect(SecurityFilter.isRestricted('id_ed25519')).toBe(true);
    });

    it('flags .npmrc', () => {
      expect(SecurityFilter.isRestricted('.npmrc')).toBe(true);
    });

    it('flags .netrc', () => {
      expect(SecurityFilter.isRestricted('.netrc')).toBe(true);
    });

    it('flags credentials.json', () => {
      expect(SecurityFilter.isRestricted('credentials.json')).toBe(true);
    });

    it('does not flag package.json', () => {
      expect(SecurityFilter.isRestricted('package.json')).toBe(false);
    });

    it('does not flag README.md', () => {
      expect(SecurityFilter.isRestricted('README.md')).toBe(false);
    });

    it('does not flag src', () => {
      expect(SecurityFilter.isRestricted('src')).toBe(false);
    });
  });

  describe('isWithinRoot', () => {
    it('accepts paths within root', () => {
      expect(SecurityFilter.isWithinRoot('/home/user/projects/app/src', ['/home/user/projects'])).toBe(true);
    });

    it('accepts exact root path', () => {
      expect(SecurityFilter.isWithinRoot('/home/user/projects', ['/home/user/projects'])).toBe(true);
    });

    it('rejects paths outside all roots', () => {
      expect(SecurityFilter.isWithinRoot('/etc/passwd', ['/home/user/projects'])).toBe(false);
    });

    it('handles Windows paths within root', () => {
      expect(SecurityFilter.isWithinRoot('C:\\Projects\\app\\src', ['C:\\Projects'])).toBe(true);
    });

    it('handles Windows paths outside root', () => {
      expect(SecurityFilter.isWithinRoot('D:\\secrets', ['C:\\Projects'])).toBe(false);
    });

    it('prevents .. traversal after normalization', () => {
      expect(SecurityFilter.isWithinRoot('/home/user/projects/../../../etc/passwd', ['/home/user/projects'])).toBe(false);
    });
  });

  describe('shouldSkipDirectory', () => {
    it('returns true for node_modules', () => {
      expect(SecurityFilter.shouldSkipDirectory('node_modules')).toBe(true);
    });

    it('returns true for .git', () => {
      expect(SecurityFilter.shouldSkipDirectory('.git')).toBe(true);
    });

    it('returns true for dist', () => {
      expect(SecurityFilter.shouldSkipDirectory('dist')).toBe(true);
    });

    it('returns true for build', () => {
      expect(SecurityFilter.shouldSkipDirectory('build')).toBe(true);
    });

    it('returns true for target', () => {
      expect(SecurityFilter.shouldSkipDirectory('target')).toBe(true);
    });

    it('returns false for src', () => {
      expect(SecurityFilter.shouldSkipDirectory('src')).toBe(false);
    });

    it('returns false for lib', () => {
      expect(SecurityFilter.shouldSkipDirectory('lib')).toBe(false);
    });

    it('returns false for app', () => {
      expect(SecurityFilter.shouldSkipDirectory('app')).toBe(false);
    });
  });
});
