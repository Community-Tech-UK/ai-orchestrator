import { EventEmitter } from 'events';
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { MimoUsageLogin, isMimoLoginNavigation } from './mimo-usage-login';
import type { MimoSavedCookie } from './mimo-saved-session-store';

function harness() {
  const generations = new Map<string, number>();
  const saved: MimoSavedCookie[][] = [];
  const savedIds: string[] = [];
  function sessionDouble() {
    let cookies: MimoSavedCookie[] = [];
    const cookieEvents = new EventEmitter();
    const cookieGet = vi.fn(async () => cookies);
    const clearStorageData = vi.fn(async () => { cookies = []; });
    const permissionRequest = vi.fn();
    const permissionCheck = vi.fn();
    const session = Object.assign(new EventEmitter(), {
      cookies: Object.assign(cookieEvents, { get: cookieGet }),
      setPermissionRequestHandler: permissionRequest,
      setPermissionCheckHandler: permissionCheck,
      clearStorageData,
      clearAuthCache: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
    }) as unknown as Session;
    return { session, cookieGet, clearStorageData, permissionRequest, permissionCheck,
      setCookies: (values: MimoSavedCookie[]) => { cookies = values; cookieEvents.emit('changed'); },
    };
  }
  const first = sessionDouble();
  const sessions = [first];
  const windows: Array<EventEmitter & { webContents: EventEmitter; closed: boolean }> = [];
  const options: BrowserWindowConstructorOptions[] = [];
  const partitions: string[] = [];
  const onChanged = vi.fn();
  const store = {
    assertEncryptionAvailable: vi.fn(),
    generation: (id: string) => generations.get(id) ?? 0,
    save: (id: string, values: MimoSavedCookie[]) => {
      saved.push(values); savedIds.push(id); generations.set(id, (generations.get(id) ?? 0) + 1);
    },
    remove: (id: string) => { generations.set(id, (generations.get(id) ?? 0) + 1); },
  };
  const login = new MimoUsageLogin({
    store,
    onChanged,
    runtime: () => ({
      createSession: (partition: string) => {
        if (partitions.length) sessions.push(sessionDouble());
        partitions.push(partition);
        return sessions.at(-1)!.session;
      },
      createWindow: (opts: BrowserWindowConstructorOptions) => {
        options.push(opts);
        const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
        const win = Object.assign(new EventEmitter(), {
          closed: false,
          loadURL: vi.fn(async () => undefined),
          focus: vi.fn(),
          isDestroyed: () => win.closed,
          close: () => { win.closed = true; win.emit('closed'); },
          destroy: vi.fn(() => { win.closed = true; win.emit('closed'); }),
        });
        const nativeWindow = Object.defineProperty(win, 'webContents', {
          get: () => {
            if (win.closed) throw new TypeError('Object has been destroyed');
            return contents;
          },
        }) as typeof win & { webContents: typeof contents };
        windows.push(nativeWindow);
        return win as unknown as BrowserWindow;
      },
    }),
  });
  return { login, options, windows, partitions, saved, savedIds, onChanged, store, sessions, ...first,
    flush: async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); },
  };
}

const completeCookies: MimoSavedCookie[] = [
  ...['api-platform_serviceToken', 'api-platform_slh', 'api-platform_ph'].map((name) => ({
    name, value: 'placeholder', domain: '.platform.xiaomimimo.com', secure: true,
  })),
  { name: 'userId', value: 'placeholder-user', domain: '.xiaomimimo.com', secure: true },
];

describe('MiMo usage login', () => {
  it('creates a sandboxed in-memory session without a Harness preload or Chrome profile', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    expect(h.partitions[0]).toMatch(/^mimo-usage-slot-/);
    expect(h.partitions[0]).not.toMatch(/^persist:/);
    expect(h.options[0].webPreferences).toMatchObject({
      session: h.session, nodeIntegration: false, contextIsolation: true, sandbox: true,
    });
    expect(h.options[0].webPreferences?.preload).toBeUndefined();
    expect(h.permissionCheck.mock.calls[0][0]()).toBe(false);
    const allowed: boolean[] = [];
    h.permissionRequest.mock.calls[0][0](null, 'camera', (value: boolean) => allowed.push(value));
    expect(allowed).toEqual([false]);
  });

  it('saves only complete scoped cookies, then closes the window and announces a quota change', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    h.setCookies(completeCookies.slice(0, 2));
    await h.flush();
    expect(h.saved).toEqual([]);
    h.setCookies([...completeCookies, { name: 'irrelevant', value: 'placeholder', domain: 'example.com' }]);
    await h.flush();
    expect(h.saved).toEqual([completeCookies]);
    expect(h.windows[0].closed).toBe(true);
    expect(h.onChanged).toHaveBeenCalledWith('work');
    expect(h.clearStorageData).toHaveBeenCalled();
  });

  it('focuses an existing login instead of opening duplicate windows', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    await h.login.connect({ id: 'work', label: 'Work' });
    expect(h.windows).toHaveLength(1);
  });

  it('disconnect invalidates a pending cookie capture so it cannot restore the login', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    let resolve!: (cookies: MimoSavedCookie[]) => void;
    h.cookieGet.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    h.setCookies(completeCookies);
    await h.login.disconnect('work');
    resolve(completeCookies);
    await h.flush();
    expect(h.saved).toEqual([]);
    expect(h.windows[0].closed).toBe(true);
  });

  it('finishes a pending capture when the user closes immediately after login', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    let resolve!: (cookies: MimoSavedCookie[]) => void;
    h.cookieGet.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    h.setCookies(completeCookies);
    h.windows[0].closed = true;
    h.windows[0].emit('closed');
    resolve(completeCookies);
    await h.flush();
    expect(h.saved).toEqual([completeCookies]);
  });

  it('blocks foreign navigation, popups and downloads', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    const preventDefault = vi.fn();
    h.windows[0].webContents.emit('will-navigate', { preventDefault }, 'https://example.com/');
    h.windows[0].webContents.emit('will-redirect', { preventDefault }, 'file:///tmp/test');
    h.session.emit('will-download', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it('bounds retained partitions across reconnects and deleted/recreated account IDs', async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      const id = `account-${i}`;
      await h.login.connect({ id, label: 'Example' });
      await h.login.disconnect(id);
    }
    expect(h.partitions).toHaveLength(1);
    expect(h.clearStorageData).toHaveBeenCalledTimes(21); // initial clear and one per release
    expect(h.session.cookies.listenerCount('changed')).toBe(0);
    expect(h.session.listenerCount('will-download')).toBe(1);
    expect(h.permissionCheck).toHaveBeenCalledTimes(1);
    expect(h.permissionRequest).toHaveBeenCalledTimes(1);
  });

  it('cleans and releases sessions when human close invalidates native window getters', async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      await h.login.connect({ id: `cancelled-${i}`, label: 'Example' });
      const window = h.windows.at(-1)!;
      const contents = window.webContents;
      window.closed = true;
      window.emit('closed');
      expect(() => window.webContents).toThrow('Object has been destroyed');
      await h.flush();
      expect(contents.listenerCount('did-finish-load')).toBe(0);
      expect(h.session.cookies.listenerCount('changed')).toBe(0);
    }
    expect(h.partitions).toHaveLength(1);
    expect(h.clearStorageData).toHaveBeenCalledTimes(21);
    expect(h.saved).toEqual([]);
    await h.login.connect({ id: 'replacement', label: 'Replacement' });
    await h.login.disconnect('replacement');
  });

  it('keeps simultaneous accounts isolated and caps the session pool', async () => {
    const h = harness();
    for (let i = 0; i < 8; i++) await h.login.connect({ id: `account-${i}`, label: 'Example' });
    expect(new Set(h.options.map((option) => option.webPreferences?.session)).size).toBe(8);
    await expect(h.login.connect({ id: 'extra', label: 'Extra' })).rejects.toThrow(/Close another/);
    expect(h.partitions).toHaveLength(8);
    h.sessions[1].setCookies(completeCookies);
    await h.flush();
    expect(h.savedIds).toEqual(['account-1']);
    for (let i = 0; i < 8; i++) await h.login.disconnect(`account-${i}`);
    await h.login.connect({ id: 'replacement', label: 'Replacement' });
    expect(h.partitions).toHaveLength(8);
    h.windows.at(-1)!.webContents.emit('did-finish-load');
    await h.flush();
    expect(h.savedIds).toEqual(['account-1']);
    await h.login.disconnect('replacement');
  });

  it('awaits cleanup before reuse and coalesces duplicate requests during preparation', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    let finishCleanup!: () => void;
    h.clearStorageData.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCleanup = resolve; }));
    const disconnect = h.login.disconnect('work');
    await h.flush();
    const first = h.login.connect({ id: 'other', label: 'Other' });
    const duplicate = h.login.connect({ id: 'other', label: 'Other' });
    await h.flush();
    expect(h.windows).toHaveLength(1);
    finishCleanup();
    await Promise.all([disconnect, first, duplicate]);
    expect(h.windows).toHaveLength(2);
    expect(h.partitions).toHaveLength(1);
    await h.login.disconnect('other');
  });

  it('cancels a login disconnected while its session is being prepared', async () => {
    const h = harness();
    let finishCleanup!: () => void;
    h.clearStorageData.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCleanup = resolve; }));
    const opening = h.login.connect({ id: 'work', label: 'Work' });
    const rejection = expect(opening).rejects.toThrow(/unavailable/);
    await h.flush();
    await h.login.disconnect('work');
    finishCleanup();
    await rejection;
    expect(h.windows).toEqual([]);
    await h.login.connect({ id: 'work', label: 'Work' });
    expect(h.partitions).toHaveLength(1);
    await h.login.disconnect('work');
  });

  it('does not let an old closed-window callback clear a reused session or save stale cookies', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    let resolve!: (cookies: MimoSavedCookie[]) => void;
    h.cookieGet.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    h.setCookies(completeCookies);
    h.windows[0].closed = true;
    h.windows[0].emit('closed');
    await h.login.disconnect('work');
    await h.login.connect({ id: 'other', label: 'Other' });
    const clearCount = h.clearStorageData.mock.calls.length;
    resolve(completeCookies);
    await h.flush();
    expect(h.clearStorageData).toHaveBeenCalledTimes(clearCount);
    expect(h.savedIds).toEqual([]);
    expect(h.windows[1].closed).toBe(false);
    h.setCookies(completeCookies);
    await h.flush();
    expect(h.savedIds).toEqual(['other']);
  });

  it('fails closed when cleanup rejects and never opens uncleared storage', async () => {
    const h = harness();
    h.clearStorageData.mockRejectedValueOnce(new Error('placeholder cleanup failure'));
    await expect(h.login.connect({ id: 'work', label: 'Work' })).rejects.toThrow(/unavailable/);
    expect(h.windows).toEqual([]);
    await h.login.connect({ id: 'work', label: 'Work' });
    expect(h.partitions).toHaveLength(2);
    expect(h.options[0].webPreferences?.session).toBe(h.sessions[1].session);
    await h.login.disconnect('work');
  });

  it('times out stalled cleanup without opening or reusing the uncleared session', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.clearStorageData.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const rejected = expect(h.login.connect({ id: 'work', label: 'Work' })).rejects.toThrow(/unavailable/);
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      expect(h.windows).toEqual([]);
      await h.login.connect({ id: 'other', label: 'Other' });
      expect(h.partitions).toHaveLength(2);
      await h.login.disconnect('other');
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys the old window before releasing its session, bypassing page close vetoes', async () => {
    const h = harness();
    await h.login.connect({ id: 'work', label: 'Work' });
    const old = h.windows[0] as unknown as BrowserWindow;
    old.close = vi.fn(); // equivalent to a page preventing ordinary close
    await h.login.disconnect('work');
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(old.isDestroyed()).toBe(true);
    await h.login.connect({ id: 'other', label: 'Other' });
    expect(h.partitions).toHaveLength(1);
    await h.login.disconnect('other');
  });

  it('rejects invalid account IDs before creating a session', async () => {
    const h = harness();
    await expect(h.login.connect({ id: '../work', label: 'Work' })).rejects.toThrow(/account/i);
    expect(h.partitions).toEqual([]);
  });

  it('refuses to open login when secure storage is unavailable', async () => {
    const h = harness();
    h.store.assertEncryptionAvailable.mockImplementation(() => { throw new Error('Secure storage unavailable'); });
    await expect(h.login.connect({ id: 'work', label: 'Work' })).rejects.toThrow(/Secure storage/);
    expect(h.windows).toEqual([]);
  });
});

describe('MiMo login navigation', () => {
  it('allows the console and Xiaomi account HTTPS origins only', () => {
    expect(isMimoLoginNavigation('https://platform.xiaomimimo.com/console/')).toBe(true);
    expect(isMimoLoginNavigation('https://account.xiaomi.com/pass/serviceLogin')).toBe(true);
    for (const url of ['http://account.xiaomi.com/', 'https://account.xiaomi.com.evil.test/',
      'https://user:placeholder@account.xiaomi.com/', 'https://account.xiaomi.com:8443/', 'javascript:alert(1)']) {
      expect(isMimoLoginNavigation(url)).toBe(false);
    }
  });
});
