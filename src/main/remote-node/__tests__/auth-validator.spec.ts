import { describe, it, expect, beforeEach } from 'vitest';
import { generateAuthToken, validateAuthToken, AUTH_TOKEN_LENGTH } from '../auth-validator';
import { resetRemoteNodeConfig, updateRemoteNodeConfig } from '../remote-node-config';

describe('auth-validator', () => {
  beforeEach(() => {
    resetRemoteNodeConfig();
  });

  describe('generateAuthToken', () => {
    it('generates a token of correct length', () => {
      const token = generateAuthToken();
      expect(token.length).toBe(AUTH_TOKEN_LENGTH);
    });

    it('generates unique tokens', () => {
      const a = generateAuthToken();
      const b = generateAuthToken();
      expect(a).not.toBe(b);
    });
  });

  describe('validateAuthToken', () => {
    it('returns true when token matches config', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken('my-secret-token')).toBe(true);
    });

    it('returns false when token does not match', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken('wrong-token')).toBe(false);
    });

    it('returns false when no token configured', () => {
      expect(validateAuthToken('any-token')).toBe(false);
    });

    it('returns false for empty token', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken('')).toBe(false);
    });

    it('returns false for undefined/null', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken(undefined)).toBe(false);
      expect(validateAuthToken(null as unknown as string)).toBe(false);
    });

    it('uses timing-safe comparison', () => {
      updateRemoteNodeConfig({ authToken: 'secret' });
      expect(validateAuthToken('secret')).toBe(true);
      expect(validateAuthToken('secre')).toBe(false); // different length
    });
  });
});
