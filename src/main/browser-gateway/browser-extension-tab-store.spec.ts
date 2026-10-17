import { describe, expect, it, vi } from 'vitest';
import { BrowserTargetRegistry } from './browser-target-registry';
import {
  BrowserExtensionTabStore,
  extensionCommandTargetForAttachment,
  makeExistingTabProfileId,
  SUSPENDED_ATTACHMENT_GRACE_MS,
} from './browser-extension-tab-store';
import { existingTabGrantNodeId } from './browser-grant-scope';

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

  it('prunes attachments a live channel stopped re-reporting (superseded generation)', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const events = { record: vi.fn() };
    let now = 1_000;
    const store = new BrowserExtensionTabStore({
      targetRegistry,
      reliabilityEvents: events,
      now: () => now,
    });
    // Old browser-session generation (windowId 7), reported at t=1000.
    store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Dead generation',
    }, { nodeId: 'node-1' });

    // Chrome restarted hours later: the new generation (windowId 8) keeps
    // reporting while the old ids are never mentioned again.
    now += 7 * 60 * 60_000;
    store.attachTab({
      tabId: 99,
      windowId: 8,
      url: 'https://example.com/',
      title: 'Live generation',
    }, { nodeId: 'node-1' });

    expect(store.listTabs().map((tab) => tab.targetId)).toEqual([
      'existing-tab:n.node-1:8:99:target',
    ]);
    expect(targetRegistry.listTargets('existing-tab:n.node-1:7:42')[0]).toMatchObject({
      status: 'closed',
    });
    expect(events.record).toHaveBeenCalledWith(
      'attachment_superseded',
      expect.objectContaining({
        nodeId: 'node-1',
        detail: expect.objectContaining({ count: 1 }),
      }),
    );
  });

  it('keeps every attachment when the whole channel has gone quiet', () => {
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
      title: 'Cached',
    }, { nodeId: 'node-1' });

    // No newer report ever arrives for this channel: silence is a channel
    // problem (suspension flow), not evidence the tabs closed.
    now += 7 * 60 * 60_000;
    expect(store.listTabs().map((tab) => tab.targetId)).toEqual([
      'existing-tab:n.node-1:7:42:target',
    ]);
  });

  it('does not let one channel\'s fresh inventory prune another channel\'s quiet tabs', () => {
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
      title: 'Quiet node',
    }, { nodeId: 'node-quiet' });

    now += 7 * 60 * 60_000;
    store.attachTab({
      tabId: 99,
      windowId: 8,
      url: 'https://example.com/',
      title: 'Local tab',
    });

    expect(store.listTabs().map((tab) => tab.targetId).sort()).toEqual([
      'existing-tab:8:99:target',
      'existing-tab:n.node-quiet:7:42:target',
    ]);
  });

  it('leaves suspended attachments to the suspension grace window, not the superseded prune', () => {
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
      title: 'Suspended',
    }, { nodeId: 'node-1' });
    store.suspendNode('node-1');

    // Fresh inventory on another channel; the suspended attachment is inside
    // its grace window and must survive.
    now += SUSPENDED_ATTACHMENT_GRACE_MS - 1_000;
    store.attachTab({
      tabId: 99,
      windowId: 8,
      url: 'https://example.com/',
      title: 'Local tab',
    });

    expect(store.listTabs().map((tab) => tab.targetId).sort()).toEqual([
      'existing-tab:8:99:target',
      'existing-tab:n.node-1:7:42:target',
    ]);
  });

  it('does not keep a host-permission failure as a readable target', () => {
    const targetRegistry = new BrowserTargetRegistry();
    const store = new BrowserExtensionTabStore({ targetRegistry, now: () => 1234 });

    const attachment = store.attachTab({
      tabId: 42,
      windowId: 7,
      url: 'https://www.lcn.com/login',
      title: 'Login - LCN',
      text: '',
      inspectionState: 'readable',
      textUnavailableReason: 'host_permission_denied',
    });

    expect(attachment.inspectionState).toBe('inspection_unavailable');
    expect(attachment.url).toBe('https://www.lcn.com/login');
    expect(attachment.title).toBe('Login - LCN');
    expect(attachment.textUnavailableReason).toBe('host_permission_denied');
    expect(targetRegistry.listTargets(attachment.profileId)).toEqual([
      expect.objectContaining({
        inspectionState: 'inspection_unavailable',
        url: 'https://www.lcn.com/login',
        title: 'Login - LCN',
        textUnavailableReason: 'host_permission_denied',
      }),
    ]);
  });
});

describe('BrowserExtensionTabStore with several Chrome profiles on one node', () => {
  const PROFILE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const PROFILE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const tab = (tabId: number, url = 'https://example.test/page') => ({ tabId, windowId: 7, url, title: 'Page' });

  function makeStore() {
    let now = 10_000;
    const reliabilityEvents = { record: vi.fn() };
    const store = new BrowserExtensionTabStore({
      targetRegistry: new BrowserTargetRegistry(),
      reliabilityEvents,
      now: () => now,
    });
    return { store, reliabilityEvents, advance: (ms: number) => { now += ms; } };
  }

  it('keeps same-numbered tabs from two profiles apart and still scopes grants per machine', () => {
    const { store } = makeStore();
    const fromA = store.attachTab(tab(42), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_A });
    const fromB = store.attachTab(tab(42), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_B });

    expect(fromA.profileId).toBe(`existing-tab:n.windows-pc:p.${PROFILE_A}:7:42`);
    expect(fromB.profileId).toBe(`existing-tab:n.windows-pc:p.${PROFILE_B}:7:42`);
    expect(store.listTabs()).toHaveLength(2);
    expect(existingTabGrantNodeId(fromA.profileId)).toBe('windows-pc');
    expect(existingTabGrantNodeId(
      makeExistingTabProfileId(undefined, 7, 42, PROFILE_A),
    )).toBe('local');
    expect(extensionCommandTargetForAttachment(fromA)).toEqual({
      profileId: fromA.profileId,
      targetId: fromA.targetId,
      tabId: 42,
      windowId: 7,
      extensionInstanceId: PROFILE_A,
    });
  });

  it('replaces a tab attached before the extension reported its profile', () => {
    const { store, reliabilityEvents } = makeStore();
    const legacy = store.attachTab(tab(42), { nodeId: 'windows-pc' });

    const upgraded = store.attachTab(tab(42), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_A });

    expect(store.listTabs().map((attachment) => attachment.targetId)).toEqual([upgraded.targetId]);
    expect(upgraded.reboundFromTargetId).toBe(legacy.targetId);
    expect(reliabilityEvents.record).toHaveBeenCalledWith('attachment_rebound', {
      nodeId: 'windows-pc',
      detail: { fromTargetId: legacy.targetId, toTargetId: upgraded.targetId },
    });
  });

  it('suspends and restores only the named profile\'s tabs', () => {
    const { store } = makeStore();
    store.attachTab(tab(1), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_A });
    store.attachTab(tab(2), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_B });

    expect(store.suspendNode('windows-pc', PROFILE_B)).toBe(1);
    const suspended = (id: number) => store.listTabs().find((attachment) => attachment.tabId === id)?.suspendedAt;
    expect(suspended(1)).toBeUndefined();
    expect(suspended(2)).toBeDefined();

    expect(store.restoreNode('windows-pc', PROFILE_A)).toBe(0);
    expect(store.restoreNode('windows-pc', PROFILE_B)).toBe(1);
    expect(suspended(2)).toBeUndefined();

    // A node-wide drop still suspends every profile.
    expect(store.suspendNode('windows-pc')).toBe(2);
  });

  it('suspends and restores only id-less tabs when asked for null', () => {
    const { store } = makeStore();
    store.attachTab(tab(1), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_A });
    store.attachTab(tab(2), { nodeId: 'windows-pc' });
    const suspended = (id: number) => store.listTabs().find((attachment) => attachment.tabId === id)?.suspendedAt;

    expect(store.suspendNode('windows-pc', null)).toBe(1);
    expect(suspended(1)).toBeUndefined();
    expect(suspended(2)).toBeDefined();

    store.suspendNode('windows-pc');
    expect(store.restoreNode('windows-pc', null)).toBe(1);
    expect(suspended(1)).toBeDefined();
    expect(suspended(2)).toBeUndefined();
  });

  it('never rebinds a suspended tab to the same URL in another profile', () => {
    const { store } = makeStore();
    const fromA = store.attachTab(tab(1), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_A });
    store.suspendNode('windows-pc', PROFILE_A);

    const fromB = store.attachTab(tab(9), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_B });
    expect(fromB.reboundFromTargetId).toBeUndefined();
    expect(store.listTabs().map((attachment) => attachment.targetId)).toContain(fromA.targetId);

    const reopenedInA = store.attachTab(tab(5), { nodeId: 'windows-pc', extensionInstanceId: PROFILE_A });
    expect(reopenedInA.reboundFromTargetId).toBe(fromA.targetId);
  });
});
