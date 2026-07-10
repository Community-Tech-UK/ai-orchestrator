import { describe, expect, it, vi } from 'vitest';
import {
  DarwinDesktopDriver,
  selectDesktopCaptureSource,
  type DesktopCaptureResult,
} from './darwin-driver';
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

  it('reports missing permissions and setup actions when TCC is not granted', async () => {
    const driver = new DarwinDesktopDriver({
      helper: makeHelper({
        health: vi.fn(async () => ({
          version: '1.0.0',
          screenRecording: false,
          accessibility: false,
          input: false,
          setupActions: ['Grant Screen Recording', 'Grant Accessibility'],
        })),
      }),
      captureScreenshot: capture(null),
    });
    const health = await driver.health();
    expect(health.screenCapture).toBe('missing_permission');
    expect(health.accessibility).toBe('missing_permission');
    expect(health.input).toBe('unavailable');
    expect(health.setupActions).toEqual(['Grant Screen Recording', 'Grant Accessibility']);
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
