import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MimoSavedSessionStore } from './mimo-saved-session-store';
import { MimoUsageCredentialsReader } from './mimo-usage-credentials-reader';
import { MimoTokenPlanProbe, type MimoTokenPlanFetch } from './mimo-token-plan-probe';
import type { MimoSessionRenewalResult } from './mimo-console-session-renewer';

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

  it.each([429, 500, 503])('does not request sign-in for HTTP %i after renewal', async (status) => {
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
