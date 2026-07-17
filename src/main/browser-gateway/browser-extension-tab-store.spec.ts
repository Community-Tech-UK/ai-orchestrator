import { describe, expect, it, vi } from 'vitest';
import { BrowserTargetRegistry } from './browser-target-registry';
import {
  BrowserExtensionTabStore,
  SUSPENDED_ATTACHMENT_GRACE_MS,
} from './browser-extension-tab-store';

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

  it('suspends attachments for a disconnected node and restores them on reconnect', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const events = { record: vi.fn() };
    let now = 1_000;
    const store = new BrowserExtensionTabStore({
      targetRegistry,
      reliabilityEvents: events,
      now: () => now,
    });
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

    expect(store.suspendNode('node-1')).toBe(1);

    // The attachment SURVIVES the drop (same ids stay valid on reconnect)…
    const suspended = store.getTab(
      'existing-tab:n.node-1:7:42',
      'existing-tab:n.node-1:7:42:target',
    );
    expect(suspended?.suspendedAt).toBe(1_000);
    // …and its registry target is marked stale, not removed.
    expect(targetRegistry.listTargets('existing-tab:n.node-1:7:42')).toEqual([
      expect.objectContaining({ id: 'existing-tab:n.node-1:7:42:target', stale: true }),
    ]);
    expect(events.record).toHaveBeenCalledWith(
      'attachment_suspended',
      expect.objectContaining({ nodeId: 'node-1' }),
    );

    now = 2_000;
    expect(store.restoreNode('node-1')).toBe(1);
    const restored = store.getTab(
      'existing-tab:n.node-1:7:42',
      'existing-tab:n.node-1:7:42:target',
    );
    expect(restored?.suspendedAt).toBeUndefined();
    expect(targetRegistry.listTargets('existing-tab:n.node-1:7:42')[0].stale).toBeUndefined();
  });

  it('deletes suspended attachments for real after the grace window', () => {
    const targetRegistry = new BrowserTargetRegistry();
    let now = 1_000;
    const store = new BrowserExtensionTabStore({
      targetRegistry,
      reliabilityEvents: { record: vi.fn() },
      now: () => now,
    });
    store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Remote',
    }, { nodeId: 'node-1' });

    store.suspendNode('node-1');
    now = 1_000 + SUSPENDED_ATTACHMENT_GRACE_MS + 1;

    expect(store.listTabs()).toEqual([]);
    expect(targetRegistry.listTargets()[0]).toMatchObject({ status: 'closed' });
  });

  it('reports a rebind when the same tab re-attaches under new ids after a drop', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const events = { record: vi.fn() };
    const store = new BrowserExtensionTabStore({
      targetRegistry,
      reliabilityEvents: events,
      now: () => 1_000,
    });
    store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Remote',
    }, { nodeId: 'node-1' });
    store.suspendNode('node-1');

    // Chrome restarted on the node: same URL, new tabId → new ids.
    const rebound = store.attachTab({
      tabId: 99,
      windowId: 8,
      url: 'https://play.google.com/console',
      title: 'Remote',
    }, { nodeId: 'node-1' });

    expect(rebound.reboundFromTargetId).toBe('existing-tab:n.node-1:7:42:target');
    expect(store.listTabs().map((tab) => tab.targetId)).toEqual([
      'existing-tab:n.node-1:8:99:target',
    ]);
    expect(targetRegistry.listTargets('existing-tab:n.node-1:8:99')[0]).toMatchObject({
      reboundFromTargetId: 'existing-tab:n.node-1:7:42:target',
    });
    expect(events.record).toHaveBeenCalledWith(
      'attachment_rebound',
      expect.objectContaining({
        nodeId: 'node-1',
        detail: {
          fromTargetId: 'existing-tab:n.node-1:7:42:target',
          toTargetId: 'existing-tab:n.node-1:8:99:target',
        },
      }),
    );
  });
});
