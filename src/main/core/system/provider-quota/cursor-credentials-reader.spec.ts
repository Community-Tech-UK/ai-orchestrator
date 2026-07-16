import { describe, it, expect } from 'vitest';
import {
  CursorCredentialsReader,
  defaultCursorVscdbPath,
  type CursorSecurityExec,
} from './cursor-credentials-reader';
import type { SqliteDriver, SqliteDriverFactory } from '../../../db/sqlite-driver';

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

/** A securityExec that fails the test if the keychain fallback is ever reached. */
const keychainMustNotBeCalled: CursorSecurityExec = async () => {
  throw new Error('keychain fallback should not have been consulted');
};

/** Fake driver factory returning `value` for the access-token ItemTable lookup. */
function vscdbFactory(value: string | null): SqliteDriverFactory {
  const driver: SqliteDriver = {
    prepare: () => ({
      get: () => (value == null ? undefined : ({ value } as never)),
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    }),
    prepareCached: () => driver.prepare(''),
    exec() {},
    pragma: () => undefined,
    transaction: (fn: (...args: unknown[]) => unknown) => fn,
    backup() {},
    close() {},
  } as unknown as SqliteDriver;
  return () => driver;
}

/** Base options that disable the vscdb source (keychain-only tests). */
const noVscdb = { vscdbPath: '/tmp/cursor-state.vscdb', fileExists: () => false } as const;

describe('CursorCredentialsReader (keychain fallback)', () => {
  it('reads the Cursor access token from the macOS keychain', async () => {
    const token = jwt({ sub: 'user-123', exp: FUTURE_SECONDS });
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      securityExec: keychainExec({ stdout: token }),
      ...noVscdb,
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
      ...noVscdb,
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
      ...noVscdb,
    });

    const { credential, reason } = await reader.read();

    expect(credential).toBeNull();
    expect(reason).toBe('expired');
  });

  it('returns malformed when the JWT has no subject', async () => {
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      securityExec: keychainExec({ stdout: jwt({ exp: FUTURE_SECONDS }) }),
      ...noVscdb,
    });

    const { credential, reason } = await reader.read();

    expect(credential).toBeNull();
    expect(reason).toBe('malformed');
  });

  it('returns unsupported on non-macOS platforms when no vscdb token exists', async () => {
    const reader = new CursorCredentialsReader({
      platform: 'linux',
      securityExec: keychainExec({ stdout: jwt({ sub: 'user-123', exp: FUTURE_SECONDS }) }),
      ...noVscdb,
    });

    const { credential, reason } = await reader.read();

    expect(credential).toBeNull();
    expect(reason).toBe('unsupported');
  });
});

describe('CursorCredentialsReader (live desktop-app vscdb)', () => {
  it('prefers the live state.vscdb token over the (stale) keychain copy', async () => {
    const liveToken = jwt({ sub: 'auth0|user_live', exp: FUTURE_SECONDS });
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      vscdbPath: '/tmp/cursor-state.vscdb',
      fileExists: () => true,
      driverFactory: vscdbFactory(liveToken),
      // The keychain must NOT be consulted when the vscdb token is valid.
      securityExec: keychainMustNotBeCalled,
    });

    const { credential, reason } = await reader.read();

    expect(reason).toBeUndefined();
    expect(credential).not.toBeNull();
    expect(credential!.token).toBe(liveToken);
    expect(credential!.subject).toBe('auth0|user_live');
  });

  it('works on non-macOS platforms via the vscdb token (no keychain needed)', async () => {
    const liveToken = jwt({ sub: 'auth0|user_live', exp: FUTURE_SECONDS });
    const reader = new CursorCredentialsReader({
      platform: 'linux',
      vscdbPath: '/tmp/cursor-state.vscdb',
      fileExists: () => true,
      driverFactory: vscdbFactory(liveToken),
      securityExec: keychainMustNotBeCalled,
    });

    const { credential } = await reader.read();

    expect(credential).not.toBeNull();
    expect(credential!.subject).toBe('auth0|user_live');
  });

  it('falls back to the keychain when the vscdb token is expired', async () => {
    const keychainToken = jwt({ sub: 'user-kc', exp: FUTURE_SECONDS });
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      vscdbPath: '/tmp/cursor-state.vscdb',
      fileExists: () => true,
      driverFactory: vscdbFactory(jwt({ sub: 'auth0|user_live', exp: PAST_SECONDS })),
      securityExec: keychainExec({ stdout: keychainToken }),
    });

    const { credential, reason } = await reader.read();

    expect(reason).toBeUndefined();
    expect(credential).not.toBeNull();
    expect(credential!.subject).toBe('user-kc');
  });

  it('reports expired when both the vscdb and keychain tokens are expired', async () => {
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      vscdbPath: '/tmp/cursor-state.vscdb',
      fileExists: () => true,
      driverFactory: vscdbFactory(jwt({ sub: 'auth0|user_live', exp: PAST_SECONDS })),
      securityExec: keychainExec({ stdout: jwt({ sub: 'user-kc', exp: PAST_SECONDS }) }),
    });

    const { credential, reason } = await reader.read();

    expect(credential).toBeNull();
    expect(reason).toBe('expired');
  });

  it('falls back to the keychain when the vscdb has no token row', async () => {
    const keychainToken = jwt({ sub: 'user-kc', exp: FUTURE_SECONDS });
    const reader = new CursorCredentialsReader({
      platform: 'darwin',
      vscdbPath: '/tmp/cursor-state.vscdb',
      fileExists: () => true,
      driverFactory: vscdbFactory(null),
      securityExec: keychainExec({ stdout: keychainToken }),
    });

    const { credential } = await reader.read();

    expect(credential).not.toBeNull();
    expect(credential!.subject).toBe('user-kc');
  });
});

describe('defaultCursorVscdbPath', () => {
  it('resolves the macOS Application Support path', () => {
    const p = defaultCursorVscdbPath('darwin', { HOME: '/Users/x' });
    expect(p).toBe('/Users/x/Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  });

  it('resolves the Windows APPDATA path', () => {
    const p = defaultCursorVscdbPath('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
    expect(p).toContain('Cursor');
    expect(p).toContain('state.vscdb');
  });

  it('resolves the Linux ~/.config path', () => {
    const p = defaultCursorVscdbPath('linux', { HOME: '/home/x' });
    expect(p).toBe('/home/x/.config/Cursor/User/globalStorage/state.vscdb');
  });
});
