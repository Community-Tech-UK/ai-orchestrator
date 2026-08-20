import { describe, expect, it, vi } from 'vitest';
import { makeService } from './browser-gateway-service.test-helpers';

/**
 * Regression cover for LT-216.
 *
 * `find_or_open` used to require that the extension re-report a tab *during*
 * the 2.5–3s inventory-refresh command it had just issued. A relay-backed node
 * re-reports each tab on a rolling sweep instead — measured at 20–55s per tab
 * against a 22-tab remote node — so live tabs were rejected roughly nine times
 * in ten. With no URL that surfaced as
 * `existing_tab_not_confirmed_after_inventory_refresh`; with a URL it fell
 * through to `openTab` and silently opened a duplicate, unauthenticated tab
 * instead of reusing the logged-in one.
 */
describe('find_or_open existing-tab confirmation horizon', () => {
  const SWEEP_LAG_MS = 30_000;

  const remoteTab = (updatedAt: number) => ({
    profileId: 'existing-tab:n.node-1:7:42',
    targetId: 'existing-tab:n.node-1:7:42:target',
    nodeId: 'node-1',
    nodeName: 'Windows PC',
    tabId: 42,
    windowId: 7,
    title: 'Bing Webmaster Tools',
    url: 'https://www.bing.com/webmasters/about',
    origin: 'https://www.bing.com',
    allowedOrigins: [{
      scheme: 'https' as const,
      hostPattern: 'www.bing.com',
      includeSubdomains: false,
    }],
    attachedAt: 1,
    updatedAt,
  });

  const silentNodeContactState = {
    getLastExtensionContactAt: () => 1_000,
    isExtensionContactFresh: () => false,
    describeExtensionContact: (nodeId: string) => ({
      nodeId,
      lastContactAt: 1_000,
      silent: true,
      staleForMs: 120_000,
    }),
    getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
  };

  it('selects a live remote tab the rolling sweep last re-reported before this refresh', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const tab = remoteTab(Date.now() - SWEEP_LAG_MS);
    const { extensionTabStore, service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
    });
    extensionTabStore.listTabs.mockReturnValue([tab]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      titleHint: 'Bing Webmaster',
      nodeId: 'node-1',
    });

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'node:node-1',
      command: 'report_inventory',
    }));
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { id: tab.targetId, profileId: tab.profileId },
    });
  });

  it('reuses the existing logged-in tab instead of opening a duplicate for the same URL', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const tab = remoteTab(Date.now() - SWEEP_LAG_MS);
    const { extensionTabStore, service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
    });
    extensionTabStore.listTabs.mockReturnValue([tab]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://www.bing.com/webmasters/about',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { id: tab.targetId },
    });
    // The duplicate-open regression: `open_tab` must never be issued while a
    // live tab for that URL is already attached.
    expect(sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      command: 'open_tab',
    }));
  });

  it('still selects the tab when the refresh command times out but extension contact is fresh', async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error('browser_extension_command_timeout');
    });
    const tab = remoteTab(Date.now() - SWEEP_LAG_MS);
    const { extensionTabStore, service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
    });
    extensionTabStore.listTabs.mockReturnValue([tab]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      titleHint: 'Bing Webmaster',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { id: tab.targetId },
    });
  });

  it('does not select a ghost tab left over from an ended browser session', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const ghost = remoteTab(Date.now() - 6 * 60 * 60 * 1_000);
    const { extensionTabStore, service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
    });
    extensionTabStore.listTabs.mockReturnValue([ghost]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      titleHint: 'Bing Webmaster',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'existing_tab_not_confirmed_after_inventory_refresh',
    });
    expect(result.data).toBeNull();
  });

  it('does not select a cached tab when the node has gone silent', async () => {
    const sendCommand = vi.fn();
    const tab = remoteTab(Date.now() - SWEEP_LAG_MS);
    const { extensionTabStore, service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
      extensionContactState: silentNodeContactState,
    });
    extensionTabStore.listTabs.mockReturnValue([tab]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      titleHint: 'Bing Webmaster',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_unreachable',
    });
    expect(result.data).toBeNull();
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
