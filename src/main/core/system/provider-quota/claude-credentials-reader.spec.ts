import { describe, it, expect } from 'vitest';
import {
  ClaudeCredentialsReader,
  type SecurityExec,
  type CredentialsFileReader,
} from './claude-credentials-reader';

const FUTURE = Date.now() + 60 * 60 * 1000;
const PAST = Date.now() - 60 * 1000;

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-test',
      refreshToken: 'sk-ant-ort01-secret',
      expiresAt: FUTURE,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      ...overrides,
    },
  });
}

function keychainExec(result: { stdout?: string; exitCode?: number; throws?: Error }): SecurityExec {
  return async () => {
    if (result.throws) throw result.throws;
    return { stdout: result.stdout ?? '', stderr: '', exitCode: result.exitCode ?? 0 };
  };
}

function readerOpts(overrides: ConstructorParameters<typeof ClaudeCredentialsReader>[0] = {}) {
  return {
    refreshCliAuth: async () => false,
    ...overrides,
  };
}

describe('ClaudeCredentialsReader', () => {
  describe('macOS keychain', () => {
    it('reads and parses a valid keychain credential', async () => {
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'darwin',
        securityExec: keychainExec({ stdout: payload() }),
      }));
      const { credential, reason } = await reader.read();
      expect(reason).toBeUndefined();
      expect(credential).not.toBeNull();
      expect(credential!.accessToken).toBe('sk-ant-oat01-test');
      expect(credential!.subscriptionType).toBe('max');
      expect(credential!.expiresAt).toBe(FUTURE);
    });

    it('passes the read-only find-generic-password args', async () => {
      const calls: string[][] = [];
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'darwin',
        securityExec: async (args) => {
          calls.push(args);
          return { stdout: payload(), stderr: '', exitCode: 0 };
        },
      }));
      await reader.read();
      expect(calls[0]).toEqual([
        'find-generic-password',
        '-s',
        'Claude Code-credentials',
        '-w',
      ]);
    });

    it('falls back to the credentials file on a keychain miss', async () => {
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'darwin',
        homeDir: '/Users/test',
        securityExec: keychainExec({ exitCode: 44 }), // 44 = item not found
        readFile: async (p) => {
          expect(p).toBe('/Users/test/.claude/.credentials.json');
          return payload();
        },
      }));
      const { credential } = await reader.read();
      expect(credential!.accessToken).toBe('sk-ant-oat01-test');
    });
  });

  describe('non-macOS file fallback', () => {
    it('reads the credentials file on linux', async () => {
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'linux',
        homeDir: '/home/test',
        readFile: async (p) => {
          expect(p).toBe('/home/test/.claude/.credentials.json');
          return payload();
        },
      }));
      const { credential } = await reader.read();
      expect(credential!.accessToken).toBe('sk-ant-oat01-test');
    });

    it('returns not-found when the file is absent', async () => {
      const enoent: CredentialsFileReader = async () => {
        throw Object.assign(new Error('no file'), { code: 'ENOENT' });
      };
      const reader = new ClaudeCredentialsReader(readerOpts({ platform: 'linux', readFile: enoent }));
      const { credential, reason } = await reader.read();
      expect(credential).toBeNull();
      expect(reason).toBe('not-found');
    });
  });

  describe('Claude Code-owned refresh', () => {
    it('reports expired when Claude Code cannot refresh the access token', async () => {
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'darwin',
        securityExec: keychainExec({ stdout: payload({ expiresAt: PAST }) }),
      }));
      const { credential, reason } = await reader.read();
      expect(credential).toBeNull();
      expect(reason).toBe('expired');
    });

    it('asks Claude Code to refresh an expired access token, then rereads it', async () => {
      let refreshed = false;
      let refreshCalls = 0;
      const reader = new ClaudeCredentialsReader({
        platform: 'darwin',
        securityExec: async () => ({
          stdout: refreshed ? payload() : payload({ expiresAt: PAST }),
          stderr: '',
          exitCode: 0,
        }),
        refreshCliAuth: async () => {
          refreshCalls += 1;
          refreshed = true;
          return true;
        },
      });

      const { credential, reason } = await reader.read();

      expect(reason).toBeUndefined();
      expect(credential?.accessToken).toBe('sk-ant-oat01-test');
      expect(credential?.expiresAt).toBe(FUTURE);
      expect(refreshCalls).toBe(1);
    });

    it('refreshes a credential inside the expiry-skew window', async () => {
      const almostExpired = Date.now() + 30_000;
      let refreshed = false;
      const reader = new ClaudeCredentialsReader({
        platform: 'darwin',
        securityExec: async () => ({
          stdout: refreshed ? payload() : payload({ expiresAt: almostExpired }),
          stderr: '',
          exitCode: 0,
        }),
        refreshCliAuth: async () => {
          refreshed = true;
          return true;
        },
      });

      const { credential } = await reader.read();
      expect(credential?.expiresAt).toBe(FUTURE);
    });

    it('accepts a token with no expiry field', async () => {
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'darwin',
        securityExec: keychainExec({ stdout: payload({ expiresAt: undefined }) }),
      }));
      const { credential } = await reader.read();
      expect(credential!.expiresAt).toBe(0);
    });
  });

  describe('malformed payloads', () => {
    it('returns malformed on invalid JSON', async () => {
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'darwin',
        securityExec: keychainExec({ stdout: 'not json' }),
      }));
      const { credential, reason } = await reader.read();
      expect(credential).toBeNull();
      expect(reason).toBe('malformed');
    });

    it('returns malformed when accessToken is missing', async () => {
      const reader = new ClaudeCredentialsReader(readerOpts({
        platform: 'darwin',
        securityExec: keychainExec({ stdout: JSON.stringify({ claudeAiOauth: {} }) }),
      }));
      const { reason } = await reader.read();
      expect(reason).toBe('malformed');
    });
  });
});
