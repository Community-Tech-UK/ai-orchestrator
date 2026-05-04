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

  it('queues and completes refresh commands for selected existing tabs', () => {
    const targetRegistry = new BrowserTargetRegistry();
    let now = 1_000;
    const store = new BrowserExtensionTabStore({
      targetRegistry,
      now: () => now,
      createCommandId: () => 'command-1',
    });
    store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
      text: 'Initial dashboard',
      screenshotBase64: 'aW5pdGlhbA==',
    });

    const command = store.queueRefresh('existing-tab:7:42', 'existing-tab:7:42:target');
    expect(command).toMatchObject({
      id: 'command-1',
      kind: 'refresh_tab',
      status: 'queued',
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    now = 1_500;
    const polled = store.pollCommand({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
    });
    expect(polled).toMatchObject({
      id: 'command-1',
      status: 'sent',
      updatedAt: 1_500,
    });

    now = 2_000;
    const completed = store.completeCommand({
      commandId: 'command-1',
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      status: 'succeeded',
      tab: {
        tabId: 42,
        windowId: 7,
        url: 'https://play.google.com/console/releases',
        title: 'Releases',
        text: 'Updated release dashboard',
        screenshotBase64: 'dXBkYXRlZA==',
        capturedAt: 1_999,
      },
    });

    expect(completed).toMatchObject({
      id: 'command-1',
      status: 'succeeded',
      updatedAt: 2_000,
    });
    expect(store.getTab('existing-tab:7:42', 'existing-tab:7:42:target')).toMatchObject({
      url: 'https://play.google.com/console/releases',
      title: 'Releases',
      text: 'Updated release dashboard',
      screenshotBase64: 'dXBkYXRlZA==',
      updatedAt: 2_000,
    });
    expect(store.pollCommand({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
    })).toBeNull();
  });

  it('does not widen the selected tab origin policy when a refresh completes after cross-origin navigation', () => {
    const store = new BrowserExtensionTabStore({
      targetRegistry: new BrowserTargetRegistry(),
      now: () => 1_000,
      createCommandId: () => 'command-1',
    });
    store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
      text: 'Initial dashboard',
    });
    store.queueRefresh('existing-tab:7:42', 'existing-tab:7:42:target');
    store.pollCommand({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
    });

    const completed = store.completeCommand({
      commandId: 'command-1',
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      status: 'succeeded',
      tab: {
        tabId: 42,
        windowId: 7,
        url: 'https://example.com/phishing',
        title: 'Blocked',
        text: 'Should not replace the cached tab',
      },
    });

    expect(completed).toMatchObject({
      id: 'command-1',
      status: 'failed',
      error: 'existing_tab_origin_not_allowed:host_not_allowed',
    });
    expect(store.getTab('existing-tab:7:42', 'existing-tab:7:42:target')).toMatchObject({
      url: 'https://play.google.com/console',
      text: 'Initial dashboard',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    });
  });
});
