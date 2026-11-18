/**
 * Automatic release of secret protection after a sign-in (17 Nov 2026). The
 * real extension code runs in a VM; Chrome's page reads are scripted per test.
 */
import { describe, expect, it } from 'vitest';
import { PROTECTED_ORIGIN, recoveryHarness, type ScriptResult, type TestCommand } from './browser-secret-recovery.testutil';

const SECRET = 'TEST_ONLY_FILLED_VALUE_7f3a';
const BLOCKED = /browser_secret_observation_blocked_for_tainted_origin/;

interface AutoReleaseRuntime {
  rememberSecretValueCheck: (origin: string, value: string) => Promise<void>;
  releaseSecretProtectionIfClear: (command: TestCommand) => Promise<void>;
  withheldIfSecretReturned: (command: TestCommand, result: unknown) => Promise<Error | null>;
  runCommandWithWatchdog: (command: TestCommand) => Promise<unknown>;
}

/** A tab on the protected site whose page read returns `page()` from every frame. */
function signedInHarness(stored: unknown = { version: 2, origins: [], tabs: {} }) {
  const h = recoveryHarness(stored);
  h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + '/login', title: 'Sign in' });
  let page: () => ScriptResult[] = () => [{ frameId: 0, result: { complete: true, texts: [SECRET] } }];
  const realExecute = h.chrome.scripting.executeScript.getMockImplementation()!;
  h.chrome.scripting.executeScript.mockImplementation(async (input) => (
    input.func.name === 'secretResidueProbe' ? page() : realExecute(input)));
  const runtime = h.context as unknown as AutoReleaseRuntime;
  return {
    ...h,
    ...runtime,
    setPage: (next: () => ScriptResult[]) => { page = next; },
    navigate: (path: string, title: string) => { h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + path, title }); },
    fill: async () => {
      await runtime.rememberSecretValueCheck(PROTECTED_ORIGIN, SECRET);
      await h.markSecretTaint(42, PROTECTED_ORIGIN);
    },
  };
}
const read = (command = 'snapshot'): TestCommand => ({ id: `${command}-1`, command, target: { tabId: 42 } });
/** The release step the native command runner takes before a read, then the read's own guard. */
async function guardRead(h: ReturnType<typeof signedInHarness>, command: TestCommand) {
  await h.releaseSecretProtectionIfClear(command);
  return h.assertSecretObservationAllowed(command);
}
const pageWith = (...texts: string[]) => () => [{ frameId: 0, result: { complete: true, texts } }];

describe('automatic release of secret protection after sign-in', () => {
  it('keeps reads blocked while the value is still in the page, and lets the submit click through', async () => {
    const h = signedInHarness();
    await h.fill();
    await expect(guardRead(h, read('query_elements'))).rejects.toThrow(BLOCKED);
    await expect(guardRead(h, read('query_elements'))).rejects.toThrow(/browser\.click/);
    await expect(guardRead(h, read('click'))).resolves.toBeUndefined();
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('releases by itself once the page has moved on and the value is gone, and records it', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith(PROTECTED_ORIGIN + '/dashboard', 'Dashboard', 'Welcome back', 'TEST_ONLY_USERNAME'));
    await expect(guardRead(h, read())).resolves.toBeUndefined();
    expect(h.secretTaintedOrigins.size).toBe(0);
    expect(h.secretTaintedTabs.size).toBe(0);
    expect(h.storage['browserGatewaySecretTaints']).toMatchObject({ origins: [], tabs: {} });
    expect(h.storage['browserGatewaySecretAutoReleasedOrigins']).toEqual([PROTECTED_ORIGIN]);
  });

  it.each([
    ['in a field of another frame', () => [
      { frameId: 0, result: { complete: true, texts: ['Dashboard'] } },
      { frameId: 3, result: { complete: true, texts: [SECRET] } },
    ]],
    ['inside longer page text', pageWith(`Your password is ${SECRET}.`)],
    ['in the address', pageWith(`${PROTECTED_ORIGIN}/done?p=${SECRET}`)],
    ['unreadable in one frame', () => [{ frameId: 0, result: { complete: true, texts: [] } }, { frameId: 1 }]],
    ['too large to read whole', () => [{ frameId: 0, result: { complete: false, texts: [] } }]],
  ])('stays protected when the value is %s', async (_case, page) => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/next', 'Next');
    h.setPage(page);
    await expect(guardRead(h, read())).rejects.toThrow(BLOCKED);
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('never releases a site that was already protected before this extension worker started', async () => {
    const h = signedInHarness({ version: 2, origins: [PROTECTED_ORIGIN], tabs: { '42': PROTECTED_ORIGIN } });
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await expect(guardRead(h, read())).rejects.toThrow(BLOCKED);
  });

  it('withholds a later read that shows the value and turns protection back on', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await guardRead(h, read('evaluate'));
    expect(await h.withheldIfSecretReturned(read('evaluate'), { value: { profile: { note: 'nothing here' } } })).toBeNull();
    const withheld = await h.withheldIfSecretReturned(read('evaluate'), { value: { state: { form: { password: SECRET } } } });
    expect(withheld?.message).toMatch(/result withheld/);
    expect(withheld?.message).not.toContain(SECRET);
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    // The next read checks the page again: blocked while the page shows the value...
    h.setPage(pageWith('Welcome back', SECRET));
    await expect(guardRead(h, read('screenshot'))).rejects.toThrow(BLOCKED);
    // ...and allowed again once only page memory held it.
    h.setPage(pageWith('Welcome back'));
    await expect(guardRead(h, read('screenshot'))).resolves.toBeUndefined();
  });

  it('after an extension restart keeps page memory, log and traffic reads refused but allows page reads', async () => {
    const first = signedInHarness();
    await first.fill();
    first.navigate('/dashboard', 'Dashboard');
    first.setPage(pageWith('Welcome back'));
    await guardRead(first, read());

    const restarted = signedInHarness(first.storage['browserGatewaySecretTaints']);
    restarted.storage['browserGatewaySecretAutoReleasedOrigins'] = first.storage['browserGatewaySecretAutoReleasedOrigins'];
    restarted.navigate('/dashboard', 'Dashboard');
    await expect(guardRead(restarted, read())).resolves.toBeUndefined();
    for (const command of ['evaluate', 'console_messages', 'network_requests', 'download_file']) {
      await expect(guardRead(restarted, read(command))).rejects.toThrow(/can no\s+longer be checked/);
    }
  });

  it('lets the popup reset clear the released-site list too', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await guardRead(h, read());
    await h.markSecretTaint(42, PROTECTED_ORIGIN);
    const status = await h.status();
    expect(await h.reset(status.reviewToken)).toEqual({ ok: true });
    expect(h.storage['browserGatewaySecretAutoReleasedOrigins']).toEqual([]);
  });

  it('returns the real page on the first read after release, through the native command runner', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await h.setGatewayEnabled(true);
    h.context['runCommandWithWatchdog'] = async () => ({ tabId: 42, url: PROTECTED_ORIGIN + '/dashboard', title: 'Dashboard', text: 'Welcome back' });
    const reply = await h.run(read());
    expect(reply).toMatchObject({ ok: true, result: { url: PROTECTED_ORIGIN + '/dashboard', text: 'Welcome back' } });
    expect(JSON.stringify(reply)).not.toContain('observationBlocked');
  });

  it('withholds a page error on a released site that carries the value', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await guardRead(h, read());
    await h.setGatewayEnabled(true);
    h.context['runCommandWithWatchdog'] = async () => { throw new Error(`Uncaught Error: ${SECRET}`); };
    const reply = await h.run(read('evaluate'));
    expect(reply).toMatchObject({ ok: false });
    expect(String(reply['error'])).toMatch(/result withheld/);
    expect(JSON.stringify(reply)).not.toContain(SECRET);
  });

  it('recognises the value as an address or a JSON string carries it', async () => {
    const h = signedInHarness();
    const value = 'TEST ONLY&"value"!(x)~\'';
    await h.rememberSecretValueCheck(PROTECTED_ORIGIN, value);
    await h.markSecretTaint(42, PROTECTED_ORIGIN);
    for (const shown of [`/done?p=${encodeURIComponent(value)}`, `/done?p=${encodeURIComponent(value).replace(/%20/g, '+')}`,
      `/done?${new URLSearchParams({ p: value })}`, JSON.stringify({ p: value })]) {
      h.setPage(pageWith(shown));
      await expect(guardRead(h, read())).rejects.toThrow(BLOCKED);
    }
    h.setPage(pageWith('Welcome back'));
    await expect(guardRead(h, read())).resolves.toBeUndefined();
  });

  it('releases again after an extension restart, but keeps page memory reads refused there', async () => {
    const first = signedInHarness();
    await first.fill();
    first.navigate('/dashboard', 'Dashboard');
    first.setPage(pageWith('Welcome back'));
    await guardRead(first, read());

    // Next day: a new worker, the site remembered as released, a fresh sign-in.
    const next = signedInHarness(first.storage['browserGatewaySecretTaints']);
    next.storage['browserGatewaySecretAutoReleasedOrigins'] = first.storage['browserGatewaySecretAutoReleasedOrigins'];
    await next.fill();
    await expect(guardRead(next, read())).rejects.toThrow(BLOCKED);
    next.navigate('/dashboard', 'Dashboard');
    next.setPage(pageWith('Welcome back'));
    await expect(guardRead(next, read())).resolves.toBeUndefined();
    expect(next.secretTaintedOrigins.size).toBe(0);
    await expect(guardRead(next, read('evaluate'))).rejects.toThrow(/can no\s+longer be checked/);
  });

  it('checks tab reports on a released site and restores protection when the page shows the value', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await guardRead(h, read());
    await h.setGatewayEnabled(true);
    let pageText = 'Welcome back';
    const probeAware = h.chrome.scripting.executeScript.getMockImplementation()!;
    h.chrome.scripting.executeScript.mockImplementation(async (input) => (input.func.name === 'pageBridgeScript'
      ? [{ frameId: 0, result: { title: 'Dashboard', text: pageText } }] : probeAware(input)));
    const tab = h.tabs.get(42)!;
    expect(JSON.stringify(await h.buildTabPayload(tab, { includeText: true }))).toContain('Welcome back');
    pageText = `Your password is ${SECRET}`;
    const payload = await h.buildTabPayload(tab, { includeText: true });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('reads the site\'s own storage in the release check, and fails closed when it cannot', () => {
    const h = signedInHarness();
    const field = (value: string) => ({ value, shadowRoot: null });
    const store = (entries: Record<string, string>) => ({
      length: Object.keys(entries).length, key: (index: number) => Object.keys(entries)[index], getItem: (key: string) => entries[key],
    });
    Object.assign(h.context, {
      location: { href: PROTECTED_ORIGIN + '/dashboard' },
      document: { title: 'Dashboard', body: { innerText: 'Welcome back' }, querySelectorAll: (query: string) => (query === '*' ? [] : [field('typed')]) },
      localStorage: store({ form: '{"password":"kept"}' }),
      sessionStorage: store({}),
    });
    const probe = h.context['secretResidueProbe'] as () => { complete: boolean; texts: string[] };
    expect(probe()).toEqual({ complete: true, texts: [PROTECTED_ORIGIN + '/dashboard', 'Dashboard', 'typed', 'form', '{"password":"kept"}', 'Welcome back'] });
    Object.defineProperty(h.context, 'sessionStorage', { get: () => { throw new Error('SecurityError'); }, configurable: true });
    expect(probe()).toEqual({ complete: false, texts: [] });
  });

  it('withholds a result on a released site that is too large to check whole', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await guardRead(h, read());
    expect(await h.withheldIfSecretReturned(read('evaluate'), { value: Array.from({ length: 30 }, () => 'clean') })).toBeNull();
    const huge = { value: Array.from({ length: 20_001 }, (_item, index) => ({ text: `item ${index}` })) };
    expect((await h.withheldIfSecretReturned(read('evaluate'), huge))?.message).toMatch(/result withheld/);
  });
});
