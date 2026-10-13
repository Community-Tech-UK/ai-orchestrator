import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MimoSavedSessionStore, type MimoSavedCookie } from './mimo-saved-session-store';
import { MimoUsageCredentialsReader } from './mimo-usage-credentials-reader';
import { MimoTokenPlanProbe } from './mimo-token-plan-probe';

const cookies: MimoSavedCookie[] = [
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_serviceToken', value: 'placeholder-console' },
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_slh', value: 'placeholder' },
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_ph', value: 'placeholder' },
  { domain: '.xiaomimimo.com', name: 'userId', value: 'placeholder-user' },
  { domain: 'account.xiaomi.com', name: 'passToken', value: 'placeholder-sso' },
];
let directory: string;
let store: MimoSavedSessionStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mimo-usage-reader-'));
  store = new MimoSavedSessionStore({ rootDir: directory, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`test-only:${text}`),
    decryptString: (data) => data.toString().slice('test-only:'.length),
  } });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function chrome() {
  const calls = { read: 0, sso: 0 };
  return { calls, reader: {
    read: async () => { calls.read++; return { session: { cookieHeader: 'placeholder-chrome', userId: 'placeholder-chrome-user' } }; },
    readAccountSso: async () => { calls.sso++; return { cookieHeader: 'placeholder-chrome-sso' }; },
  } };
}

describe('MimoUsageCredentialsReader', () => {
  it('reads the saved account session and SSO without touching Chrome', async () => {
    store.save('mimo-a', cookies);
    const fallback = chrome();
    const reader = new MimoUsageCredentialsReader({ accountProfileId: 'mimo-a', savedStore: store, chromeProfile: 'Profile 1', chromeReader: fallback.reader });
    expect((await reader.read()).session?.userId).toBe('placeholder-user');
    expect(await reader.readAccountSso()).toEqual({ cookieHeader: 'passToken=placeholder-sso' });
    expect(fallback.calls).toEqual({ read: 0, sso: 0 });
    expect(reader.quotaSource).toBe('saved:1');
  });

  it('refuses Chrome fallback when a saved connection is corrupt', async () => {
    store.save('mimo-a', cookies);
    writeFileSync(join(directory, 'mimo-a.bin'), 'invalid-test-placeholder');
    const fallback = chrome();
    const reader = new MimoUsageCredentialsReader({ accountProfileId: 'mimo-a', savedStore: store, chromeProfile: 'Profile 1', chromeReader: fallback.reader });
    expect(await reader.read()).toEqual({ session: null, reason: 'malformed' });
    expect(await reader.readAccountSso()).toEqual({ cookieHeader: '' });
    expect(fallback.calls).toEqual({ read: 0, sso: 0 });
  });

  it('keeps explicit Chrome associations working when no saved login exists', async () => {
    const fallback = chrome();
    const reader = new MimoUsageCredentialsReader({ accountProfileId: 'mimo-a', savedStore: store, chromeProfile: 'Profile 1', chromeReader: fallback.reader });
    expect((await reader.read()).session?.userId).toBe('placeholder-chrome-user');
    expect(reader.quotaSource).toBe('chrome:Profile 1');
  });

  it('does not use a Default Chrome login for a pooled account with no association', async () => {
    const fallback = chrome();
    const reader = new MimoUsageCredentialsReader({ accountProfileId: 'mimo-a', savedStore: store, chromeReader: fallback.reader });
    expect(await reader.read()).toEqual({ session: null, reason: 'not-found' });
    expect(fallback.calls.read).toBe(0);
    expect(reader.reauthError()).toMatch(/Connect usage/);
  });

  it('invalidates a reader and refuses renewal persistence after disconnect', async () => {
    store.save('mimo-a', cookies);
    const reader = new MimoUsageCredentialsReader({ accountProfileId: 'mimo-a', savedStore: store });
    store.remove('mimo-a');
    expect(reader.isCurrent()).toBe(false);
    reader.saveRenewed({ cookieHeader: 'placeholder', userId: 'placeholder-user' });
    expect(store.exists('mimo-a')).toBe(false);
  });

  it('persists a validated renewed session on the same saved connection', async () => {
    store.save('mimo-a', cookies);
    const reader = new MimoUsageCredentialsReader({ accountProfileId: 'mimo-a', savedStore: store });
    const session = (await reader.read()).session!;
    reader.saveRenewed({ ...session, cookieHeader: session.cookieHeader.replace('placeholder-console', 'placeholder-renewed') });
    expect(store.read('mimo-a').session?.cookieHeader).toContain('api-platform_serviceToken=placeholder-renewed');
    expect(reader.isCurrent()).toBe(true);
  });

  it('drops quota if the saved connection is removed during a request', async () => {
    store.save('mimo-a', cookies);
    const reader = new MimoUsageCredentialsReader({ accountProfileId: 'mimo-a', savedStore: store });
    const probe = new MimoTokenPlanProbe({
      isTokenPlanModel: () => true, reader,
      fetchPlans: async () => {
        store.remove('mimo-a');
        return { usage: { status: 200, body: { data: { usage: { items: [{ name: 'plan_total_token', used: 10, limit: 100 }] } } } }, detail: { status: 200, body: {} } };
      },
    });
    expect(await probe.probe({ signal: new AbortController().signal })).toBeNull();
  });
});
