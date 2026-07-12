import { describe, it, expect } from 'vitest';
import {
  AgyCredentialsReader,
  type AgySecurityExec,
} from './agy-credentials-reader';

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0); // 2026-07-11T12:00:00Z

/** Serialize a credential the way go-keyring stores it: prefix:base64(JSON). */
function keyringValue(token: Record<string, unknown>): string {
  const json = JSON.stringify({ token, auth_method: 'oauth' });
  return `go-keyring-base64:${Buffer.from(json, 'utf8').toString('base64')}`;
}

function exec(result: { stdout?: string; exitCode?: number } | Error): AgySecurityExec {
  return async () => {
    if (result instanceof Error) throw result;
    return { stdout: result.stdout ?? '', stderr: '', exitCode: result.exitCode ?? 0 };
  };
}

function reader(result: { stdout?: string; exitCode?: number } | Error, platform: NodeJS.Platform = 'darwin') {
  return new AgyCredentialsReader({
    platform,
    now: () => NOW,
    securityExec: exec(result),
    refreshCliAuth: async () => false,
  });
}

describe('AgyCredentialsReader', () => {
  it('decodes the keyring credential and reads access_token + expiry', async () => {
    const stdout = keyringValue({
      access_token: 'agy-access-token',
      token_type: 'Bearer',
      refresh_token: 'agy-refresh-token',
      expiry: '2026-07-11T20:24:50.908062+01:00',
    });
    const { credential, reason } = await reader({ stdout }).read();
    expect(reason).toBeUndefined();
    expect(credential).toEqual({
      accessToken: 'agy-access-token',
      expiresAt: Date.parse('2026-07-11T20:24:50.908062+01:00'),
    });
  });

  it('treats a credential with no expiry as usable (expiresAt=0)', async () => {
    const stdout = keyringValue({ access_token: 'agy-access-token' });
    const { credential } = await reader({ stdout }).read();
    expect(credential).toEqual({ accessToken: 'agy-access-token', expiresAt: 0 });
  });

  it('reports expired when the keyring expiry is in the past', async () => {
    const stdout = keyringValue({
      access_token: 'agy-access-token',
      expiry: '2026-07-11T11:00:00Z',
    });
    const { credential, reason } = await reader({ stdout }).read();
    expect(credential).toBeNull();
    expect(reason).toBe('expired');
  });

  it('asks AGY to silently refresh an expired keyring credential, then rereads it', async () => {
    const expired = keyringValue({
      access_token: 'expired-access-token',
      refresh_token: 'agy-refresh-token',
      expiry: '2026-07-11T11:00:00Z',
    });
    const fresh = keyringValue({
      access_token: 'fresh-access-token',
      refresh_token: 'agy-refresh-token',
      expiry: '2026-07-11T13:00:00Z',
    });
    let refreshed = false;
    let refreshCalls = 0;
    const r = new AgyCredentialsReader({
      platform: 'darwin',
      now: () => NOW,
      securityExec: async () => ({
        stdout: refreshed ? fresh : expired,
        stderr: '',
        exitCode: 0,
      }),
      refreshCliAuth: async () => {
        refreshCalls += 1;
        refreshed = true;
        return true;
      },
    });

    const { credential, reason } = await r.read();

    expect(reason).toBeUndefined();
    expect(credential).toEqual({
      accessToken: 'fresh-access-token',
      expiresAt: Date.parse('2026-07-11T13:00:00Z'),
    });
    expect(refreshCalls).toBe(1);
  });

  it('refreshes a keyring credential within the caller expiry-skew window', async () => {
    const almostExpired = keyringValue({
      access_token: 'almost-expired-access-token',
      expiry: '2026-07-11T12:01:00Z',
    });
    const fresh = keyringValue({
      access_token: 'fresh-access-token',
      expiry: '2026-07-11T13:00:00Z',
    });
    let refreshed = false;
    const r = new AgyCredentialsReader({
      platform: 'darwin',
      now: () => NOW,
      securityExec: async () => ({
        stdout: refreshed ? fresh : almostExpired,
        stderr: '',
        exitCode: 0,
      }),
      refreshCliAuth: async () => {
        refreshed = true;
        return true;
      },
    });

    const { credential } = await r.read();

    expect(credential?.accessToken).toBe('fresh-access-token');
  });

  it('reports malformed when the keyring expiry is not a valid timestamp', async () => {
    const stdout = keyringValue({
      access_token: 'agy-access-token',
      expiry: 'not-a-timestamp',
    });
    const { credential, reason } = await reader({ stdout }).read();
    expect(credential).toBeNull();
    expect(reason).toBe('malformed');
  });

  it('reports not-found when the keychain item is absent (non-zero exit)', async () => {
    const { credential, reason } = await reader({ exitCode: 44 }).read();
    expect(credential).toBeNull();
    expect(reason).toBe('not-found');
  });

  it('reports not-found on an empty keychain value', async () => {
    const { credential, reason } = await reader({ stdout: '   ' }).read();
    expect(credential).toBeNull();
    expect(reason).toBe('not-found');
  });

  it('reports malformed when the value has no prefix delimiter', async () => {
    const { credential, reason } = await reader({ stdout: 'not-a-keyring-value' }).read();
    expect(credential).toBeNull();
    expect(reason).toBe('malformed');
  });

  it('reports malformed when the base64 payload lacks an access token', async () => {
    const stdout = `go-keyring-base64:${Buffer.from('{"token":{}}', 'utf8').toString('base64')}`;
    const { credential, reason } = await reader({ stdout }).read();
    expect(credential).toBeNull();
    expect(reason).toBe('malformed');
  });

  it('reports unsupported on non-macOS platforms without touching the keychain', async () => {
    let called = false;
    const r = new AgyCredentialsReader({
      platform: 'linux',
      now: () => NOW,
      securityExec: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const { credential, reason } = await r.read();
    expect(credential).toBeNull();
    expect(reason).toBe('unsupported');
    expect(called).toBe(false);
  });

  it('reports not-found when the security exec throws', async () => {
    const { credential, reason } = await reader(new Error('spawn EACCES')).read();
    expect(credential).toBeNull();
    expect(reason).toBe('not-found');
  });
});
