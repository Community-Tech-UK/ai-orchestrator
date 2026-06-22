import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProfile } from '@contracts/types/browser';
import { BrowserTargetRegistry } from './browser-target-registry';
import { PuppeteerBrowserDriver } from './puppeteer-browser-driver';

function makeProfile(): BrowserProfile {
  return {
    id: 'profile-1',
    label: 'Local Test',
    mode: 'session',
    browser: 'chrome',
    userDataDir: '/tmp/browser-profile',
    allowedOrigins: [],
    status: 'stopped',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeIsolatedProfile(): BrowserProfile {
  return {
    ...makeProfile(),
    id: 'isolated-profile',
    mode: 'isolated',
  };
}

describe('PuppeteerBrowserDriver', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a profile and indexes browser pages as targets', async () => {
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
    };
    const browser = {
      pages: async () => [page],
    };
    const targetRegistry = new BrowserTargetRegistry();
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry,
    });

    const targets = await driver.openProfile(makeProfile(), 'http://localhost:4567');

    expect(targets).toEqual([
      expect.objectContaining({
        profileId: 'profile-1',
        title: 'Local',
        url: 'http://localhost:4567',
        origin: 'http://localhost:4567',
        driver: 'cdp',
        status: 'available',
      }),
    ]);
    expect(targetRegistry.listTargets('profile-1')).toHaveLength(1);
  });

  it('marks indexed targets from isolated profiles as isolated', async () => {
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
    };
    const browser = {
      pages: async () => [page],
    };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
    });

    const targets = await driver.openProfile(makeIsolatedProfile(), 'http://localhost:4567');

    expect(targets[0]).toMatchObject({
      profileId: 'isolated-profile',
      mode: 'isolated',
    });
  });

  it('returns bounded snapshots and base64 screenshots', async () => {
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      evaluate: async () => 'x'.repeat(13_000),
      screenshot: vi.fn().mockResolvedValue('base64-image'),
    };
    const browser = {
      pages: async () => [page],
    };
    const targetRegistry = new BrowserTargetRegistry();
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry,
    });
    const [target] = await driver.openProfile(makeProfile());

    const snapshot = await driver.snapshot('profile-1', target.id);
    const screenshot = await driver.screenshot('profile-1', target.id);

    expect(snapshot).toEqual({
      title: 'Local',
      url: 'http://localhost:4567',
      text: 'x'.repeat(12_000),
    });
    expect(screenshot).toBe('base64-image');
    expect(page.screenshot).toHaveBeenCalledWith({
      type: 'png',
      encoding: 'base64',
      fullPage: true,
    });
  });

  it('passes screenshot fullPage options through to Puppeteer', async () => {
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      screenshot: vi.fn().mockResolvedValue('base64-image'),
    };
    const browser = {
      pages: async () => [page],
    };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
    });
    const [target] = await driver.openProfile(makeProfile());

    await driver.screenshot('profile-1', target.id, { fullPage: false });

    expect(page.screenshot).toHaveBeenCalledWith({
      type: 'png',
      encoding: 'base64',
      fullPage: false,
    });
  });

  it('falls back to an open-shadow selector script when Puppeteer CSS click misses', async () => {
    const click = vi.fn(async () => {
      throw new Error('No element found for selector');
    });
    const evaluate = vi.fn(async () => ({ tagName: 'BUTTON', text: 'Register' }));
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      click,
      evaluate,
    };
    const browser = {
      pages: async () => [page],
    };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
    });
    const [target] = await driver.openProfile(makeProfile());

    await driver.click('profile-1', target.id, 'button.register');

    expect(click).toHaveBeenCalledWith('button.register');
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      action: 'click',
      args: ['button.register'],
    });
  });

  it('captures bounded redacted console messages and network requests', async () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      on: vi.fn((event: string, handler: (value: unknown) => void) => {
        handlers.set(event, handler);
        return page;
      }),
    };
    const browser = {
      pages: async () => [page],
    };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
    });
    const [target] = await driver.openProfile(makeProfile());

    handlers.get('console')?.({
      type: () => 'error',
      text: () => 'token=abc123 safe=value',
      location: () => ({
        url: 'http://localhost:4567/app.js?token=abc123',
        lineNumber: 12,
      }),
    });
    handlers.get('request')?.({
      url: () => 'http://localhost:4567/api?token=abc123&safe=value',
      method: () => 'POST',
      resourceType: () => 'xhr',
      headers: () => ({
        Authorization: 'Bearer abc123',
        Accept: 'application/json',
      }),
    });

    await expect(driver.consoleMessages('profile-1', target.id)).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        text: 'token=[REDACTED] safe=value',
        location: expect.objectContaining({
          url: 'http://localhost:4567/app.js?token=%5BREDACTED%5D',
          lineNumber: 12,
        }),
      }),
    ]);
    await expect(driver.networkRequests('profile-1', target.id)).resolves.toEqual([
      expect.objectContaining({
        url: 'http://localhost:4567/api?token=%5BREDACTED%5D&safe=value',
        method: 'POST',
        resourceType: 'xhr',
        headers: {
          Authorization: '[REDACTED]',
          Accept: 'application/json',
        },
      }),
    ]);
  });

  it('navigates, refreshes target metadata, waits, and clears targets on close', async () => {
    let currentUrl = 'http://localhost:4567';
    const goto = vi.fn(async (url: string) => {
      currentUrl = url;
    });
    const waitForSelector = vi.fn();
    const page = {
      url: () => currentUrl,
      title: async () => currentUrl.endsWith('/next') ? 'Next' : 'Local',
      goto,
      waitForSelector,
    };
    const browser = {
      pages: async () => [page],
    };
    const closeProfile = vi.fn();
    const targetRegistry = new BrowserTargetRegistry();
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile,
      },
      targetRegistry,
    });
    const [target] = await driver.openProfile(makeProfile());
    targetRegistry.selectTarget(target.id);

    await driver.navigate('profile-1', target.id, 'http://localhost:4567/next');
    await driver.waitFor('profile-1', target.id, 'main', 5_000);
    const [refreshed] = targetRegistry.listTargets('profile-1');
    await driver.closeProfile('profile-1');

    expect(goto).toHaveBeenCalledWith('http://localhost:4567/next', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(refreshed).toMatchObject({
      url: 'http://localhost:4567/next',
      title: 'Next',
      origin: 'http://localhost:4567',
      status: 'selected',
    });
    expect(waitForSelector).toHaveBeenCalledWith('main', { timeout: 5_000 });
    expect(closeProfile).toHaveBeenCalledWith('profile-1');
    expect(targetRegistry.listTargets('profile-1')).toEqual([]);
  });

  it('inspects elements for classification', async () => {
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      $eval: vi.fn().mockResolvedValue({
        role: 'button',
        accessibleName: 'Submit for review',
        visibleText: 'Submit',
        inputType: 'submit',
        attributes: {
          'data-action': 'publish',
        },
      }),
    };
    const browser = {
      pages: async () => [page],
    };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
    });
    const [target] = await driver.openProfile(makeProfile());

    await expect(driver.inspectElement('profile-1', target.id, 'button')).resolves.toMatchObject({
      role: 'button',
      accessibleName: 'Submit for review',
      attributes: {
        'data-action': 'publish',
      },
    });
    expect(page.$eval).toHaveBeenCalledWith('button', expect.any(Function));
  });

  it('runs mutating actions and refreshes target metadata', async () => {
    let currentUrl = 'http://localhost:4567';
    const elementHandle = {
      uploadFile: vi.fn(),
    };
    const page = {
      url: () => currentUrl,
      title: async () => currentUrl.endsWith('/mutated') ? 'Mutated' : 'Local',
      click: vi.fn(async () => {
        currentUrl = 'http://localhost:4567/mutated';
      }),
      type: vi.fn(),
      select: vi.fn(),
      $: vi.fn().mockResolvedValue(elementHandle),
    };
    const browser = {
      pages: async () => [page],
    };
    const targetRegistry = new BrowserTargetRegistry();
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry,
    });
    const [target] = await driver.openProfile(makeProfile());

    await driver.click('profile-1', target.id, 'button.publish');
    await driver.type('profile-1', target.id, 'input[name="title"]', 'Release notes');
    await driver.fillForm('profile-1', target.id, [
      { selector: '#one', value: 'One' },
      { selector: '#two', value: 'Two' },
    ]);
    await driver.select('profile-1', target.id, 'select.track', 'production');
    await driver.uploadFile('profile-1', target.id, 'input[type="file"]', '/tmp/app.aab');

    expect(page.click).toHaveBeenCalledWith('button.publish');
    expect(page.type).toHaveBeenCalledWith('input[name="title"]', 'Release notes');
    expect(page.type).toHaveBeenCalledWith('#one', 'One');
    expect(page.type).toHaveBeenCalledWith('#two', 'Two');
    expect(page.select).toHaveBeenCalledWith('select.track', 'production');
    expect(page.$).toHaveBeenCalledWith('input[type="file"]');
    expect(elementHandle.uploadFile).toHaveBeenCalledWith('/tmp/app.aab');
    expect(targetRegistry.listTargets('profile-1')[0]).toMatchObject({
      url: 'http://localhost:4567/mutated',
      title: 'Mutated',
    });
  });

  it('keeps CDP-driven pages focused and alive against background throttling', async () => {
    vi.useFakeTimers();
    const sendCalls: { method: string; params?: Record<string, unknown> }[] = [];
    const detach = vi.fn(async () => undefined);
    const cdpSession = {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        sendCalls.push({ method, ...(params ? { params } : {}) });
      }),
      detach,
    };
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      createCDPSession: vi.fn(async () => cdpSession),
    };
    const browser = {
      pages: async () => [page],
    };
    const closeProfile = vi.fn();
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile,
      },
      targetRegistry: new BrowserTargetRegistry(),
      lifecycleHeartbeatMs: 1_000,
    });

    const [target] = await driver.openProfile(makeProfile());

    const methods = () => sendCalls.map((call) => call.method);
    expect(sendCalls).toContainEqual({
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
    });
    expect(sendCalls).toContainEqual({
      method: 'Page.setWebLifecycleState',
      params: { state: 'active' },
    });
    expect(methods()).toContain('Page.enable');

    const lifecycleCallsBefore = methods().filter((m) => m === 'Page.setWebLifecycleState').length;
    await vi.advanceTimersByTimeAsync(1_000);
    const lifecycleCallsAfter = methods().filter((m) => m === 'Page.setWebLifecycleState').length;
    expect(lifecycleCallsAfter).toBe(lifecycleCallsBefore + 1);

    await driver.closeProfile(target.id.split(':')[0]!);
    expect(detach).toHaveBeenCalled();

    const lifecycleCallsAtClose = methods().filter((m) => m === 'Page.setWebLifecycleState').length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(methods().filter((m) => m === 'Page.setWebLifecycleState').length).toBe(
      lifecycleCallsAtClose,
    );
  });

  it('auto-recovers a wedged target by reloading it', async () => {
    vi.useFakeTimers();
    const reload = vi.fn(async () => undefined);
    // Lifecycle/focus commands succeed (browser-process), but the renderer
    // liveness probe (Runtime.evaluate) fails — the "page pings fine but element
    // ops are wedged" signature.
    const cdpSession = {
      send: vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          throw new Error('renderer unresponsive');
        }
      }),
      detach: vi.fn(async () => undefined),
    };
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      createCDPSession: vi.fn(async () => cdpSession),
      reload,
    };
    const browser = { pages: async () => [page] };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
      lifecycleHeartbeatMs: 1_000,
    });

    const [target] = await driver.openProfile(makeProfile());
    expect(driver.listWedgedTargets()).toEqual([]);

    // Two consecutive failed probes cross the wedged threshold.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(driver.listWedgedTargets()).toEqual([target.id]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith({
      waitUntil: 'domcontentloaded',
      timeout: expect.any(Number),
    });

    // A further tick must not trigger a second reload while still wedged.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(1);

    await driver.closeProfile('profile-1');
  });

  it('does not auto-reload a wedged target when recovery is disabled', async () => {
    vi.useFakeTimers();
    const reload = vi.fn(async () => undefined);
    const cdpSession = {
      send: vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          throw new Error('renderer unresponsive');
        }
      }),
      detach: vi.fn(async () => undefined),
    };
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
      createCDPSession: vi.fn(async () => cdpSession),
      reload,
    };
    const browser = { pages: async () => [page] };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
      lifecycleHeartbeatMs: 1_000,
      autoRecoverWedged: false,
    });

    const [target] = await driver.openProfile(makeProfile());
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(driver.listWedgedTargets()).toEqual([target.id]);
    expect(reload).not.toHaveBeenCalled();

    await driver.closeProfile('profile-1');
  });

  it('keeps mid-session tabs alive by re-indexing on targetcreated', async () => {
    const pageA = { url: () => 'http://localhost:4567/a', title: async () => 'A' };
    const pageB = { url: () => 'http://localhost:4567/b', title: async () => 'B' };
    let pages: (typeof pageA)[] = [pageA];
    const handlers: Record<string, () => void> = {};
    const browser = {
      pages: async () => pages,
      on: (event: string, handler: () => void) => {
        handlers[event] = handler;
      },
    };
    const targetRegistry = new BrowserTargetRegistry();
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry,
      antiThrottle: false,
    });

    await driver.openProfile(makeProfile());
    expect(typeof handlers['targetcreated']).toBe('function');
    expect(targetRegistry.listTargets('profile-1')).toHaveLength(1);

    // A tab opened mid-session must be picked up without an explicit listTargets.
    pages = [pageA, pageB];
    handlers['targetcreated']!();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(targetRegistry.listTargets('profile-1')).toHaveLength(2);
  });

  it('skips anti-throttle setup for pages without a CDP session', async () => {
    const page = {
      url: () => 'http://localhost:4567',
      title: async () => 'Local',
    };
    const browser = {
      pages: async () => [page],
    };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
    });

    await expect(driver.openProfile(makeProfile())).resolves.toHaveLength(1);
  });

  it('uses browser download events and returns completed download metadata', async () => {
    let currentUrl = 'http://localhost:4567';
    const handlers = new Map<string, (value: unknown) => void>();
    const cdpSession = {
      send: vi.fn(async () => undefined),
      on: vi.fn((event: string, handler: (value: unknown) => void) => {
        handlers.set(event, handler);
        return cdpSession;
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
        return cdpSession;
      }),
    };
    const page = {
      url: () => currentUrl,
      title: async () => 'Local',
      createCDPSession: vi.fn(async () => cdpSession),
      click: vi.fn(async () => {
        currentUrl = 'http://localhost:4567/downloaded';
        queueMicrotask(() => {
          handlers.get('Page.downloadWillBegin')?.({
            guid: 'guid-1',
            url: 'http://localhost:4567/report.csv',
            suggestedFilename: 'report.csv',
          });
          handlers.get('Page.downloadProgress')?.({
            guid: 'guid-1',
            state: 'completed',
            receivedBytes: 42,
            totalBytes: 42,
          });
        });
      }),
    };
    const browser = {
      pages: async () => [page],
    };
    const driver = new PuppeteerBrowserDriver({
      launcher: {
        launchProfile: vi.fn().mockResolvedValue({}),
        getBrowser: () => browser,
        closeProfile: vi.fn(),
      },
      targetRegistry: new BrowserTargetRegistry(),
    });
    const [target] = await driver.openProfile(makeProfile());

    const result = await driver.downloadFile('profile-1', target.id, {
      selector: 'a.download',
      timeoutMs: 60_000,
    });

    expect(result).toMatchObject({
      url: 'http://localhost:4567/report.csv',
      filename: '/tmp/browser-profile/Downloads/report.csv',
      state: 'complete',
      bytesReceived: 42,
    });
    expect(cdpSession.send).toHaveBeenCalledWith('Page.enable');
    expect(cdpSession.send).toHaveBeenCalledWith('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '/tmp/browser-profile/Downloads',
    });
    expect(page.click).toHaveBeenCalledWith('a.download');
  });
});
