import { describe, expect, it, vi } from 'vitest';
import {
  DarwinDesktopDriver,
  mapScreenAccessStatus,
  selectDesktopCaptureSource,
  type DesktopCaptureResult,
} from './darwin-driver';
import { UnsupportedDesktopDriver } from './desktop-driver';
import type { DesktopHelperClient, DesktopHelperHealth } from './desktop-helper-protocol';
import type {
  DesktopAppDescriptor,
} from '../../../shared/types/desktop-gateway.types';

const APPS: DesktopAppDescriptor[] = [
  {
    appId: 'darwin-app:com.apple.Preview',
    displayName: 'Preview',
    platform: 'darwin',
    bundleId: 'com.apple.Preview',
    pid: 321,
    visibleWindowCount: 1,
  },
];

function makeHelper(overrides: Partial<DesktopHelperClient> = {}): DesktopHelperClient {
  const health: DesktopHelperHealth = {
    version: '1.0.0',
    screenRecording: true,
    accessibility: true,
    input: true,
    setupActions: [],
  };
  return {
    health: vi.fn(async () => health),
    requestAccessibility: vi.fn(async () => true),
    listApps: vi.fn(async () => APPS),
    accessibilitySnapshot: vi.fn(async () => ({
      appId: 'darwin-app:com.apple.Preview',
      nodes: [],
      capturedAt: 1,
    })),
    click: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    hotkey: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    drag: vi.fn(async () => undefined),
    ...overrides,
  };
}

const capture = (result: DesktopCaptureResult | null) =>
  vi.fn(async () => result);

describe('DarwinDesktopDriver', () => {
  it('fails closed instead of selecting another app when the requested window is absent', () => {
    const sources = [
      { id: 'screen:1', name: 'Entire Screen' },
      { id: 'window:other', name: 'Password Manager' },
    ];

    expect(selectDesktopCaptureSource(sources, {
      windowId: 'window:preview',
      displayName: 'Preview',
    })).toBeNull();
  });

  it('matches a helper CGWindow id to Electron desktopCapturer window ids', () => {
    const preview = { id: 'window:12345:0', name: 'Document.pdf' };

    expect(selectDesktopCaptureSource([preview], {
      windowId: '12345',
      displayName: 'Preview',
    })).toBe(preview);
  });

  it('maps helper health into driver capability states', async () => {
    const driver = new DarwinDesktopDriver({
      helper: makeHelper(),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'granted',
    });
    const health = await driver.health();
    expect(health).toMatchObject({
      platform: 'darwin',
      supported: true,
      screenCapture: 'available',
      accessibility: 'available',
      input: 'available',
    });
  });

  it('maps every Electron media-access status to a capability state', () => {
    expect(mapScreenAccessStatus('granted')).toBe('available');
    expect(mapScreenAccessStatus('not-determined')).toBe('missing_permission');
    expect(mapScreenAccessStatus('denied')).toBe('missing_permission');
    expect(mapScreenAccessStatus('restricted')).toBe('unavailable');
    expect(mapScreenAccessStatus('unknown')).toBe('unavailable');
    expect(mapScreenAccessStatus('anything-else')).toBe('unavailable');
  });

  it('never lets the helper screenRecording flag override the Electron status', async () => {
    const helperSaysGranted = new DarwinDesktopDriver({
      helper: makeHelper({
        health: vi.fn(async () => ({
          version: '1.1.0',
          screenRecording: true,
          accessibility: true,
          input: true,
          setupActions: [],
        })),
      }),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'denied',
    });
    await expect(helperSaysGranted.health()).resolves.toMatchObject({
      screenCapture: 'missing_permission',
    });

    const helperSaysDenied = new DarwinDesktopDriver({
      helper: makeHelper({
        health: vi.fn(async () => ({
          version: '1.1.0',
          screenRecording: false,
          accessibility: true,
          input: true,
          setupActions: [],
        })),
      }),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'granted',
    });
    await expect(helperSaysDenied.health()).resolves.toMatchObject({
      screenCapture: 'available',
    });
  });

  it('keeps an independently available Screen Recording state when the helper is missing', async () => {
    const driver = new DarwinDesktopDriver({
      helper: makeHelper({
        health: vi.fn(async () => ({
          version: '1.1.0',
          screenRecording: false,
          accessibility: false,
          input: false,
          setupActions: ['Reinstall Harness.'],
          mode: 'unavailable' as const,
          degraded: true,
          issue: 'helper_missing' as const,
        })),
      }),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'granted',
    });
    const health = await driver.health();
    expect(health.screenCapture).toBe('available');
    expect(health.accessibility).toBe('unavailable');
    expect(health.input).toBe('unavailable');
    expect(health.setupActions).toEqual(['Reinstall Harness.']);
  });

  it('maps Accessibility false to missing_permission for accessibility and input', async () => {
    const driver = new DarwinDesktopDriver({
      helper: makeHelper({
        health: vi.fn(async () => ({
          version: '1.1.0',
          screenRecording: false,
          accessibility: false,
          input: false,
          setupActions: [],
        })),
      }),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'denied',
    });
    const health = await driver.health();
    expect(health.screenCapture).toBe('missing_permission');
    expect(health.accessibility).toBe('missing_permission');
    expect(health.input).toBe('missing_permission');
    expect(health.setupActions).toEqual([
      'Grant Screen Recording to Harness in System Settings → Privacy & Security → Screen Recording.',
      'Grant Accessibility to Harness in System Settings → Privacy & Security → Accessibility.',
    ]);
  });

  it('does not prompt when the requested permission is already ready', async () => {
    const requestScreenAccess = vi.fn(async () => undefined);
    const helper = makeHelper();
    const driver = new DarwinDesktopDriver({
      helper,
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'granted',
      requestScreenAccess,
    });

    await expect(driver.requestSystemPermission('screen-recording')).resolves.toEqual({
      permission: 'screen-recording',
      state: 'available',
      nativeRequestAttempted: false,
    });
    expect(requestScreenAccess).not.toHaveBeenCalled();

    await expect(driver.requestSystemPermission('accessibility')).resolves.toEqual({
      permission: 'accessibility',
      state: 'available',
      nativeRequestAttempted: false,
    });
    expect(helper.requestAccessibility).not.toHaveBeenCalled();
  });

  it('performs one minimal screen source request then rechecks the Electron status', async () => {
    const statuses = ['denied', 'denied', 'denied', 'granted'];
    const requestScreenAccess = vi.fn(async () => undefined);
    const driver = new DarwinDesktopDriver({
      helper: makeHelper(),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => statuses.shift() ?? 'granted',
      requestScreenAccess,
    });

    await expect(driver.requestSystemPermission('screen-recording')).resolves.toEqual({
      permission: 'screen-recording',
      state: 'missing_permission',
      nativeRequestAttempted: true,
    });
    expect(requestScreenAccess).toHaveBeenCalledOnce();

    await expect(driver.requestSystemPermission('screen-recording')).resolves.toEqual({
      permission: 'screen-recording',
      state: 'available',
      nativeRequestAttempted: true,
    });
  });

  it('invokes the helper Accessibility prompt then rechecks helper health', async () => {
    let trusted = false;
    const helper = makeHelper({
      health: vi.fn(async () => ({
        version: '1.1.0',
        screenRecording: false,
        accessibility: trusted,
        input: trusted,
        setupActions: [],
      })),
      requestAccessibility: vi.fn(async () => {
        trusted = true;
        return false;
      }),
    });
    const driver = new DarwinDesktopDriver({
      helper,
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'granted',
    });

    await expect(driver.requestSystemPermission('accessibility')).resolves.toEqual({
      permission: 'accessibility',
      state: 'available',
      nativeRequestAttempted: true,
    });
    expect(helper.requestAccessibility).toHaveBeenCalledOnce();
  });

  it('returns a safe state when the native request fails', async () => {
    const driver = new DarwinDesktopDriver({
      helper: makeHelper(),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'denied',
      requestScreenAccess: vi.fn(async () => {
        throw new Error('capture backend exploded with PRIVATE_CONTENT');
      }),
    });

    const result = await driver.requestSystemPermission('screen-recording');
    expect(result).toEqual({
      permission: 'screen-recording',
      state: 'missing_permission',
      nativeRequestAttempted: true,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONTENT');
  });

  it('deduplicates concurrent requests for the same permission', async () => {
    let release: (() => void) | null = null;
    const requestScreenAccess = vi.fn(() =>
      new Promise<void>((resolve) => { release = resolve; }));
    const driver = new DarwinDesktopDriver({
      helper: makeHelper(),
      captureScreenshot: capture(null),
      getScreenAccessStatus: () => 'denied',
      requestScreenAccess,
    });

    const first = driver.requestSystemPermission('screen-recording');
    const second = driver.requestSystemPermission('screen-recording');
    release?.();
    await Promise.all([first, second]);
    expect(requestScreenAccess).toHaveBeenCalledOnce();
  });

  it('captures a screenshot through the injected backend and stamps capturedAt', async () => {
    const driver = new DarwinDesktopDriver({
      helper: makeHelper(),
      captureScreenshot: capture({
        data: 'BASE64',
        mimeType: 'image/png',
        width: 100,
        height: 50,
        windowId: 'win-1',
      }),
      now: () => 4242,
    });
    const result = await driver.screenshot({ appId: 'darwin-app:com.apple.Preview' });
    expect(result).toMatchObject({
      appId: 'darwin-app:com.apple.Preview',
      windowId: 'win-1',
      data: 'BASE64',
      mimeType: 'image/png',
      width: 100,
      height: 50,
      capturedAt: 4242,
    });
  });

  it('throws when the capture backend cannot find the target', async () => {
    const driver = new DarwinDesktopDriver({
      helper: makeHelper(),
      captureScreenshot: capture(null),
    });
    await expect(driver.screenshot({ appId: 'darwin-app:com.apple.Preview' }))
      .rejects.toThrow('computer_use_target_not_found');
  });

  it('returns a typed unsupported result for both permissions on unsupported platforms', async () => {
    const driver = new UnsupportedDesktopDriver('linux');

    await expect(driver.requestSystemPermission('screen-recording')).resolves.toEqual({
      permission: 'screen-recording',
      state: 'unsupported',
      nativeRequestAttempted: false,
    });
    await expect(driver.requestSystemPermission('accessibility')).resolves.toEqual({
      permission: 'accessibility',
      state: 'unsupported',
      nativeRequestAttempted: false,
    });
  });

  it('delegates input actions to the helper and returns an ok result', async () => {
    const helper = makeHelper();
    const driver = new DarwinDesktopDriver({
      helper,
      captureScreenshot: capture(null),
      now: () => 7,
    });
    const result = await driver.click({
      appId: 'darwin-app:com.apple.Preview',
      observationToken: 'obs',
      x: 1,
      y: 2,
    });
    expect(helper.click).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: 'ok',
      appId: 'darwin-app:com.apple.Preview',
      completedAt: 7,
    });
  });
});
