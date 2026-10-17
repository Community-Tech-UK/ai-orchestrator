import { createCipheriv, createDecipheriv } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { MimoConsoleSessionRenewer } from './mimo-console-session-renewer';
import { MimoSavedSessionStore } from './mimo-saved-session-store';
import { MimoTokenPlanProbe } from './mimo-token-plan-probe';
import { MimoUsageCredentialsReader } from './mimo-usage-credentials-reader';

// Deterministic test encryption, with no live credentials or Keychain access.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => {
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), Buffer.alloc(12, 2));
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  },
  decryptString: (encrypted: Buffer) => {
    const cipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 1), Buffer.alloc(12, 2));
    cipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]).toString();
  },
};

describe('MiMo renewal persistence', () => {
  it('persists quoted renewal cookies and reuses them on the next probe after reopening storage', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mimo-refresh-persistence-'));
    try {
      const store = new MimoSavedSessionStore({ rootDir, safeStorage });
      store.save('test-account', [
        { domain: '.platform.xiaomimimo.com', name: 'api-platform_serviceToken', value: 'PLACEHOLDER_OLD_SERVICE' },
        { domain: '.platform.xiaomimimo.com', name: 'api-platform_slh', value: 'PLACEHOLDER_OLD_SLH' },
        { domain: '.platform.xiaomimimo.com', name: 'api-platform_ph', value: 'PLACEHOLDER_OLD_PH' },
        { domain: '.xiaomimimo.com', name: 'userId', value: 'PLACEHOLDER_USER' },
        { domain: 'account.xiaomi.com', name: 'passToken', value: 'PLACEHOLDER_OLD_SSO' },
      ]);
      let hop = 0;
      const renewFetch = vi.fn(async () => {
        const first = hop++ === 0;
        const cookies = first
          ? ['passToken="PLACEHOLDER_FRESH_SSO"; Domain=account.xiaomi.com']
          : [
            'api-platform_serviceToken="PLACEHOLDER_FRESH_SERVICE"; Domain=.platform.xiaomimimo.com',
            'api-platform_slh="PLACEHOLDER_FRESH_SLH"; Domain=.platform.xiaomimimo.com',
            'api-platform_ph="PLACEHOLDER_FRESH_PH"; Domain=.platform.xiaomimimo.com',
            'userId=PLACEHOLDER_USER; Domain=.xiaomimimo.com',
          ];
        return {
          status: first ? 302 : 307,
          headers: {
            getSetCookie: () => cookies,
            get: (name: string) => name === 'location'
              ? first ? 'https://platform.xiaomimimo.com/sts' : 'http://platform.xiaomimimo.com/api/v1/tokenPlan/usage'
              : null,
          },
        };
      });
      const renewer = new MimoConsoleSessionRenewer({ fetchImpl: renewFetch });
      const freshHeader = 'api-platform_serviceToken=PLACEHOLDER_FRESH_SERVICE; api-platform_slh=PLACEHOLDER_FRESH_SLH; api-platform_ph=PLACEHOLDER_FRESH_PH; userId=PLACEHOLDER_USER';
      const fetchPlans = vi.fn(async (session: { cookieHeader: string }) => session.cookieHeader.includes('PLACEHOLDER_OLD_SERVICE')
        ? {
          usage: { status: 401, body: { loginUrl: 'https://account.xiaomi.com/pass/serviceLogin' } },
          detail: { status: 401, body: {} },
        }
        : {
          usage: { status: 200, body: { data: { usage: { items: [{ name: 'plan_total_token', used: 41, limit: 100 }] } } } },
          detail: { status: 200, body: {} },
        });
      const probe = new MimoTokenPlanProbe({
        isTokenPlanModel: () => true,
        reader: new MimoUsageCredentialsReader({ accountProfileId: 'test-account', savedStore: store }),
        renewer,
        fetchPlans,
      });
      const first = await probe.probe({ signal: new AbortController().signal });
      expect(first?.ok).toBe(true);
      expect(first?.windows[0]).toMatchObject({ used: 41, limit: 100 });
      expect(renewFetch).toHaveBeenCalledTimes(2);

      const reopened = new MimoSavedSessionStore({ rootDir, safeStorage });
      expect(reopened.read('test-account').session?.cookieHeader).toBe(freshHeader);
      expect(reopened.readAccountSso('test-account').cookieHeader).toBe('passToken=PLACEHOLDER_FRESH_SSO');
      const nextProbe = new MimoTokenPlanProbe({
        isTokenPlanModel: () => true,
        reader: new MimoUsageCredentialsReader({ accountProfileId: 'test-account', savedStore: reopened }),
        renewer,
        fetchPlans,
      });
      const next = await nextProbe.probe({ signal: new AbortController().signal });
      expect(next?.ok).toBe(true);
      expect(next?.needsReauth).toBeUndefined();
      expect(fetchPlans).toHaveBeenCalledTimes(3);
      expect(fetchPlans.mock.calls[2][0].cookieHeader).toBe(freshHeader);
      expect(renewFetch).toHaveBeenCalledTimes(2);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });
});
