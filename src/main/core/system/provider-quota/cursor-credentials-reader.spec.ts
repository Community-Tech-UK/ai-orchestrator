import { describe, it, expect } from 'vitest';
import {
  CursorCredentialsReader,
  type CursorSecurityExec,
} from './cursor-credentials-reader';

const FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 60 * 60;
const PAST_SECONDS = Math.floor(Date.now() / 1000) - 60;

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64url');
  return `header.${encoded}.signature`;
}

function keychainExec(result: { stdout?: string; exitCode?: number; throws?: Error }): CursorSecurityExec {
  return async () => {
    if (result.throws) throw result.throws;
    return { stdout: result.stdout ?? '', stderr: '', exitCode: result.exitCode ?? 0 };
  };
}

describe('CursorCredentialsReader', () => {
  it('reads the Cursor access token from the macOS keychain', async () => {
    const token = jwt({ sub: 'user-123', exp: FUTURE_SECONDS });
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      securityExec: keychainExec({ stdout: token }),
    });

    const { credential, reason } = await reader.read();

    expect(reason).toBeUndefined();
    expect(credential).not.toBeNull();
    expect(credential!.token).toBe(token);
    expect(credential!.subject).toBe('user-123');
    expect(credential!.expiresAt).toBe(FUTURE_SECONDS * 1000);
  });

  it('passes the read-only Cursor keychain args', async () => {
    const calls: string[][] = [];
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      securityExec: async (args) => {
        calls.push(args);
        return { stdout: jwt({ sub: 'user-123', exp: FUTURE_SECONDS }), stderr: '', exitCode: 0 };
      },
    });

    await reader.read();

    expect(calls[0]).toEqual([
      'find-generic-password',
      '-s',
      'cursor-access-token',
      '-a',
      'cursor-user',
      '-w',
    ]);
  });

  it('returns expired without refreshing an expired session token', async () => {
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      securityExec: keychainExec({ stdout: jwt({ sub: 'user-123', exp: PAST_SECONDS }) }),
    });

    const { credential, reason } = await reader.read();

    expect(credential).toBeNull();
    expect(reason).toBe('expired');
  });

  it('returns malformed when the JWT has no subject', async () => {
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      securityExec: keychainExec({ stdout: jwt({ exp: FUTURE_SECONDS }) }),
    });

    const { credential, reason } = await reader.read();

    expect(credential).toBeNull();
    expect(reason).toBe('malformed');
  });

  it('returns unsupported on non-macOS platforms', async () => {
    const reader = new CursorCredentialsReader({
      platform: 'linux',
      securityExec: keychainExec({ stdout: jwt({ sub: 'user-123', exp: FUTURE_SECONDS }) }),
    });

    const { credential, reason } = await reader.read();

    expect(credential).toBeNull();
    expect(reason).toBe('unsupported');
  });
});
