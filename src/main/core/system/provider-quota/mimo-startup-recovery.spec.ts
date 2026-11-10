import { createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MimoSavedSessionStore } from './mimo-saved-session-store';
import { MimoUsageCredentialsReader } from './mimo-usage-credentials-reader';
import { MimoTokenPlanProbe, type MimoTokenPlanFetch } from './mimo-token-plan-probe';
import { MimoConsoleSessionRenewer, type MimoSessionRenewalResult } from './mimo-console-session-renewer';

const ACCOUNT = 'placeholder-spare';
const COOKIES = [
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_serviceToken', value: 'PLACEHOLDER_SERVICE' },
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_slh', value: 'PLACEHOLDER_SLH' },
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_ph', value: 'PLACEHOLDER_PH' },
  { domain: '.xiaomimimo.com', name: 'userId', value: 'PLACEHOLDER_USER' },
];
const OK = {
  usage: { status: 200, body: { data: { usage: { items: [{ name: 'plan_total_token', used: 75, limit: 100 }] } } } },
  detail: { status: 200, body: { data: { planName: 'Max' } } },
};
const REJECTED = {
  usage: { status: 401, body: { loginUrl: 'https://account.xiaomi.com/pass/serviceLogin' } },
  detail: { status: 401, body: {} },
};

describe('MiMo saved-login startup recovery', () => {
  let directory: string;
  let available: boolean;
  let store: MimoSavedSessionStore;
  let reader: MimoUsageCredentialsReader;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mimo-startup-recovery-'));
    available = true;
    store = new MimoSavedSessionStore({ rootDir: directory, safeStorage: {
      isEncryptionAvailable: () => available,
      encryptString: (text) => Buffer.from(`test-only:${text}`),
      decryptString: (data) => data.toString().slice('test-only:'.length),
    } });
    store.save(ACCOUNT, COOKIES);
    reader = new MimoUsageCredentialsReader({ accountProfileId: ACCOUNT, savedStore: store });
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function probe(fetchPlans: MimoTokenPlanFetch = async () => OK): MimoTokenPlanProbe {
    return new MimoTokenPlanProbe({ isTokenPlanModel: () => true, reader, fetchPlans });
  }

  it('recovers a temporarily locked saved login within the same startup probe', async () => {
    const original = readFileSync(join(directory, `${ACCOUNT}.bin`));
    available = false;
    const read = vi.spyOn(store, 'read').mockImplementationOnce(() => {
      queueMicrotask(() => { available = true; });
      return { session: null, reason: 'denied' };
    });
    const fetchPlans = vi.fn(async () => OK);
    const result = await probe(fetchPlans).probe({ signal: new AbortController().signal });
    expect(read).toHaveBeenCalledTimes(2);
    expect(fetchPlans).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, plan: 'Max', windows: [{ used: 75, limit: 100 }] });
    expect(result?.needsReauth).toBeUndefined();
    expect(readFileSync(join(directory, `${ACCOUNT}.bin`))).toEqual(original);
  });

  it('bounds persistent storage retries without requesting sign-in or reading Chrome', async () => {
    available = false;
    const read = vi.spyOn(store, 'read');
    const chromeRead = vi.fn();
    reader = new MimoUsageCredentialsReader({ accountProfileId: ACCOUNT, savedStore: store, chromeProfile: 'Default', chromeReader: { read: chromeRead } });
    const fetchPlans = vi.fn(async () => OK);
    const result = await probe(fetchPlans).probe({ signal: new AbortController().signal });
    expect(read).toHaveBeenCalledTimes(3);
    expect(fetchPlans).not.toHaveBeenCalled();
    expect(chromeRead).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, needsReauth: false, error: 'MiMo saved usage login could not be unlocked. Try Refresh again shortly.', windows: [] });
    expect(store.exists(ACCOUNT)).toBe(true);
  });

  it('cancels a pending storage retry without another read or warning snapshot', async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = vi.spyOn(store, 'read').mockImplementation(() => {
      timer = setTimeout(() => controller.abort(), 20);
      return { session: null, reason: 'denied' };
    });
    try {
      expect(await probe().probe({ signal: controller.signal })).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timer); }
  });

  it.each(['disconnect', 'reconnect'] as const)('does not reuse a connection after %s during the storage retry', async (kind) => {
    const read = vi.spyOn(store, 'read').mockImplementationOnce(() => {
      queueMicrotask(() => {
        store.remove(ACCOUNT);
        if (kind === 'reconnect') store.save(ACCOUNT, COOKIES);
      });
      return { session: null, reason: 'denied' };
    });
    const fetchPlans = vi.fn(async () => OK);
    expect(await probe(fetchPlans).probe({ signal: new AbortController().signal })).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(fetchPlans).not.toHaveBeenCalled();
    expect(store.exists(ACCOUNT)).toBe(kind === 'reconnect');
  });

  it.each(['missing', 'corrupt'] as const)('still requests sign-in for a genuinely %s saved login', async (kind) => {
    if (kind === 'missing') store.remove(ACCOUNT);
    else writeFileSync(join(directory, `${ACCOUNT}.bin`), 'PLACEHOLDER_CORRUPT');
    reader = new MimoUsageCredentialsReader({ accountProfileId: ACCOUNT, savedStore: store });
    const fetchPlans = vi.fn(async () => OK);
    expect(await probe(fetchPlans).probe({ signal: new AbortController().signal })).toMatchObject({ ok: false, needsReauth: true, windows: [] });
    expect(fetchPlans).not.toHaveBeenCalled();
  });

  async function renewalProbe(
    retry: MimoTokenPlanFetch,
    renewal: () => Promise<MimoSessionRenewalResult> = async () => ({ attempted: true, completed: true, setCookies: new Map(), ssoCookies: [] }),
  ) {
    let calls = 0;
    const save = vi.spyOn(reader, 'saveRenewed');
    const result = await new MimoTokenPlanProbe({
      isTokenPlanModel: () => true, reader,
      fetchPlans: async (session, options) => ++calls === 1 ? REJECTED : retry(session, options),
      renewer: { renew: renewal },
    }).probe({ signal: new AbortController().signal });
    return { result, save, calls };
  }

  it('does not report an expired login when the request after renewal times out', async () => {
    const { result, save } = await renewalProbe(async () => { throw Object.assign(new Error('PLACEHOLDER_PRIVATE'), { name: 'AbortError' }); });
    expect(result).toMatchObject({ ok: false, error: 'MiMo Token Plan request aborted/timed out', windows: [] });
    expect(result?.needsReauth).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([429, 503])('does not request sign-in for HTTP %i after renewal', async (status) => {
    const { result, save } = await renewalProbe(async () => ({ usage: { status, body: {} }, detail: OK.detail }));
    expect(result?.ok).toBe(false);
    expect(result?.needsReauth).toBeUndefined();
    expect(result?.error).toContain('Try Refresh');
    expect(save).not.toHaveBeenCalled();
  });

  it('does not request sign-in or persist cookies for unreadable renewed usage data', async () => {
    const { result, save } = await renewalProbe(async () => ({ usage: { status: 200, body: {} }, detail: OK.detail }));
    expect(result).toMatchObject({ ok: false, error: 'MiMo Token Plan endpoints returned no usage windows after session refresh' });
    expect(result?.needsReauth).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([401, 403])('still requests sign-in when the renewed login is rejected with HTTP %i', async (status) => {
    const { result, save } = await renewalProbe(async () => ({ usage: { status, body: {} }, detail: OK.detail }));
    expect(result).toMatchObject({ ok: false, needsReauth: true, error: 'MiMo usage login expired (401/403). Choose Connect usage in Accounts to sign in again.' });
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['throttled', 'incomplete', 'exception'] as const)('does not turn a %s renewal into proof of expired credentials', async (kind) => {
    const { result, calls } = await renewalProbe(async () => OK, async () => {
      if (kind === 'exception') throw new Error('PLACEHOLDER_PRIVATE');
      return { attempted: kind !== 'throttled', completed: false, setCookies: new Map(), ssoCookies: [] };
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, error: 'MiMo usage session refresh is temporarily unavailable. Try Refresh again shortly.' });
    expect(result?.needsReauth).toBeUndefined();
  });
});

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
