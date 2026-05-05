import { describe, expect, it } from 'vitest';
import { BrowserTargetRegistry } from './browser-target-registry';
import { BrowserExtensionTabStore } from './browser-extension-tab-store';

describe('BrowserExtensionTabStore', () => {
  it('registers a selected Chrome tab as an existing-tab browser target', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const store = new BrowserExtensionTabStore({ targetRegistry, now: () => 1234 });

    const attachment = store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
      text: 'Release dashboard',
      screenshotBase64: 'cG5n',
      capturedAt: 1000,
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    });

    expect(attachment).toMatchObject({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
      text: 'Release dashboard',
      screenshotBase64: 'cG5n',
    });
    expect(targetRegistry.listTargets('existing-tab:7:42')).toEqual([
      expect.objectContaining({
        id: 'existing-tab:7:42:target',
        profileId: 'existing-tab:7:42',
        mode: 'existing-tab',
        driver: 'extension',
        status: 'selected',
        url: 'https://play.google.com/console',
      }),
    ]);
  });

  it('rejects non-http existing-tab attachments before target registration', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const store = new BrowserExtensionTabStore({ targetRegistry });

    expect(() =>
      store.attachTab({
        tabId: 42,
        windowId: 7,
        url: 'chrome://settings',
        title: 'Settings',
      }),
    ).toThrow(/unsupported_existing_tab_url/);
    expect(targetRegistry.listTargets()).toEqual([]);
  });

});
