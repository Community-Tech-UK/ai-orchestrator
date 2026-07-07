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
        lastSeenAt: 1234,
        lastConfirmedAt: 1234,
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

  it('namespaces remote node tab ids and stores node metadata on targets', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const store = new BrowserExtensionTabStore({ targetRegistry, now: () => 1234 });

    const attachment = store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
    }, { nodeId: 'node-1', nodeName: 'Windows PC' });

    expect(attachment).toMatchObject({
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
    });
    expect(targetRegistry.listTargets('existing-tab:n.node-1:7:42')).toEqual([
      expect.objectContaining({
        id: 'existing-tab:n.node-1:7:42:target',
        nodeId: 'node-1',
        nodeName: 'Windows PC',
      }),
    ]);
  });

  it('expires all attachments for a disconnected remote node', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const store = new BrowserExtensionTabStore({ targetRegistry });
    store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Remote',
    }, { nodeId: 'node-1' });
    store.attachTab({
      tabId: 43,
      windowId: 7,
      url: 'https://example.com',
      title: 'Local',
    });

    store.expireNode('node-1');

    expect(store.listTabs().map((tab) => tab.profileId)).toEqual(['existing-tab:7:43']);
    expect(targetRegistry.listTargets()).toEqual([
      expect.objectContaining({ id: 'existing-tab:7:43:target' }),
    ]);
  });
});
