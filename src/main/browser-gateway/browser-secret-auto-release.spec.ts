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

  it('keeps a remembered value out of a sign-in prompt\'s details after release', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await guardRead(h, read());
    expect(h.secretTaintedOrigins.size).toBe(0);
    // The page then sends the tab to a server that echoes the value in its
    // Basic realm, and Chrome holds the tab on its own prompt.
    const leakOrigin = 'https://test-only-leak.example';
    h.tabs.set(42, { id: 42, windowId: 7, url: leakOrigin + '/', title: leakOrigin });
    const runtime = h as unknown as { httpAuthChallenges: Map<number, Record<string, unknown>> };
    runtime.httpAuthChallenges.set(42, { origin: leakOrigin, scheme: 'basic', realm: `Hi ${SECRET}`, at: 1 });
    h.chrome.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: leakOrigin + '/', errorOccurred: true, documentLifecycle: 'active' },
    ]);

    await h.setGatewayEnabled(true);
    const challenge = await h.run({ id: 'prompt-origin-1', command: 'http_auth_challenge', target: { tabId: 42 } });
    expect(challenge).toMatchObject({ ok: false, error: 'browser_secret_observation_blocked_for_tainted_origin' });
    const payload = await h.buildTabPayload(h.tabs.get(42)!, { includeText: false });
    expect(payload).not.toHaveProperty('httpAuthChallenge');
    expect(JSON.stringify([challenge, payload])).not.toContain(SECRET);

    // The same prompt without the value is reported.
    runtime.httpAuthChallenges.set(42, { origin: leakOrigin, scheme: 'basic', realm: 'Members', at: 1 });
    expect(await h.run({ id: 'prompt-origin-2', command: 'http_auth_challenge', target: { tabId: 42 } }))
      .toMatchObject({ ok: true, result: { origin: leakOrigin } });
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

  it('releases the site even when an unreadable tab on another site was swept into the lock, which stays locked alone', async () => {
    // 17 Nov 2026 live check, ct-test-mac: a local network page the extension
    // cannot read was marked with the site when the password was written.
    const h = signedInHarness();
    h.tabs.set(77, { id: 77, windowId: 7, url: 'http://192.168.0.96:8765/page.html', title: 'Local page' });
    let otherTabReadable = false;
    const probeAware = h.chrome.scripting.executeScript.getMockImplementation()!;
    h.chrome.scripting.executeScript.mockImplementation(async (input) => {
      if (input.target.tabId === 77 && !otherTabReadable) throw new Error('Cannot access contents of the page');
      if (input.target.tabId === 77 && input.func.name === 'secretResidueProbe') return pageWith('Local page')();
      return probeAware(input);
    });
    await h.fill();
    expect(h.secretTaintedTabs.get('77')).toBe(PROTECTED_ORIGIN);

    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await expect(guardRead(h, read())).resolves.toBeUndefined();
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
    // The tab that could not be checked stays locked on its own.
    const otherRead = { id: 'other-1', command: 'snapshot', target: { tabId: 77 } };
    await expect(guardRead(h, otherRead)).rejects.toThrow(BLOCKED);
    expect(h.secretTaintedTabs.get('77')).toBe(PROTECTED_ORIGIN);

    // Once it can be read and is clean, it is released too.
    otherTabReadable = true;
    await expect(guardRead(h, otherRead)).resolves.toBeUndefined();
    expect(h.secretTaintedTabs.size).toBe(0);
  });

  it('keeps the whole site locked when a tab showing the site cannot be read', async () => {
    const h = signedInHarness();
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(() => { throw new Error('Cannot access contents of the page'); });
    await expect(guardRead(h, read())).rejects.toThrow(BLOCKED);
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  /** The 18 Nov situation: site released, unreadable tab 77 on another site kept locked on its own. */
  async function withKeptTab() {
    const h = signedInHarness();
    h.tabs.set(77, { id: 77, windowId: 7, url: 'http://192.168.0.96:8765/page.html', title: 'Local page' });
    const state = { otherTabReadable: false, otherTabTexts: ['Local page'] };
    const probeAware = h.chrome.scripting.executeScript.getMockImplementation()!;
    h.chrome.scripting.executeScript.mockImplementation(async (input) => {
      if (input.target.tabId === 77 && !state.otherTabReadable) throw new Error('Cannot access contents of the page');
      if (input.target.tabId === 77 && input.func.name === 'secretResidueProbe') return pageWith(...state.otherTabTexts)();
      return probeAware(input);
    });
    await h.fill();
    h.navigate('/dashboard', 'Dashboard');
    h.setPage(pageWith('Welcome back'));
    await guardRead(h, read());
    expect(h.secretTaintedTabs.get('77')).toBe(PROTECTED_ORIGIN);
    return { h, state, otherRead: { id: 'other-1', command: 'snapshot', target: { tabId: 77 } } as TestCommand };
  }

  it('lets the Harness recovery release a tab kept locked on its own', async () => {
    const { h } = await withKeptTab();
    await h.setGatewayEnabled(true);
    const review = await h.run({ id: 'review-1', command: 'secret_protection_review', target: { tabId: 77 }, payload: {} });
    const reviewed = review['result'] as { state: string; origins: string[]; writeGeneration: string; reviewToken: string };
    expect(reviewed).toMatchObject({ state: 'protected', origins: [PROTECTED_ORIGIN] });
    const released = await h.run({ id: 'release-1', command: 'release_secret_observation', target: { tabId: 77 }, payload: {
      operationId: 'op-test-only-0002', reviewToken: reviewed.reviewToken, origins: reviewed.origins, writeGeneration: reviewed.writeGeneration,
    } });
    expect(released).toMatchObject({ ok: true, result: { released: true, clearedTabCount: 1 } });
    expect(h.secretTaintedTabs.size).toBe(0);
  });

  it('does not release a kept tab once older values for its site were forgotten', async () => {
    const { h, state, otherRead } = await withKeptTab();
    // Sign-ins on 16 other sites push this site's remembered values out.
    for (let index = 0; index < 16; index++) await h.rememberSecretValueCheck(`https://test-only-${index}.example`, `TEST_ONLY_OTHER_${index}`);
    // A newer value for the site is remembered; the first one, still in tab 77, is not.
    await h.rememberSecretValueCheck(PROTECTED_ORIGIN, 'TEST_ONLY_NEWER_VALUE');
    state.otherTabReadable = true;
    state.otherTabTexts = [SECRET];
    await expect(guardRead(h, otherRead)).rejects.toThrow(BLOCKED);
  });

  it('does not rewrite protection or cancel recovery reviews when a kept tab is still unreadable', async () => {
    const { h, otherRead } = await withKeptTab();
    const writes = h.chrome.storage.local.set.mock.calls.length;
    await expect(guardRead(h, otherRead)).rejects.toThrow(BLOCKED);
    expect(h.chrome.storage.local.set.mock.calls.length).toBe(writes);
  });
});
