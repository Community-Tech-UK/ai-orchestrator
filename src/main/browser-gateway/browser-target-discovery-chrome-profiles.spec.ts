import { describe, expect, it, vi } from 'vitest';
import type { BrowserExtensionCommandStore } from './browser-extension-command-store';
import type { BrowserExtensionSendCommandRequest } from './browser-extension-command-delivery';
import { makeService } from './browser-gateway-service.test-helpers';
import { compactAgentTargetListing } from './browser-agent-target-listing';

/**
 * 2026-11-13: windows-pc ran the extension in two Chrome profiles. A nightly
 * Facebook search's `find_or_open` opened its tab in whichever profile polled
 * first, which was not signed in to Facebook, although every earlier run had
 * worked in the signed-in profile.
 */
describe('find_or_open with several Chrome profiles on one computer', () => {
  const MAIN = '0b779001-ea2a-4929-9faf-3ba30930ae8a';
  const OTHER = 'cfe036dd-7881-414a-af83-a02bf92f537b';
  const URL = 'https://www.facebook.com/marketplace/';

  function setup(options: {
    connected: string[];
    usage?: { extensionInstanceId: string; siteActions: number; totalActions: number }[];
    tabs?: ReturnType<typeof facebookTab>[];
  }) {
    const sendCommand = vi.fn(async (request: BrowserExtensionSendCommandRequest) =>
      request.command === 'open_tab'
        ? { tab: { tabId: 99, windowId: 5, title: 'Marketplace', url: URL } }
        : { ok: true });
    const commandStore: Pick<BrowserExtensionCommandStore, 'sendCommand' | 'listRecentExtensionInstances'> = {
      sendCommand,
      listRecentExtensionInstances: vi.fn(() => options.connected),
    };
    const fixture = makeService({ profile: null, profiles: [], extensionCommandStore: commandStore });
    fixture.auditStore.countChromeProfileUse.mockReturnValue(options.usage ?? []);
    fixture.extensionTabStore.listTabs.mockReturnValue(options.tabs ?? []);
    return { ...fixture, sendCommand, commandStore };
  }

  function facebookTab(extensionInstanceId: string) {
    const profileId = `existing-tab:n.node-1:p.${extensionInstanceId}:5:7`;
    return {
      profileId,
      targetId: `${profileId}:target`,
      nodeId: 'node-1',
      extensionInstanceId,
      tabId: 7,
      windowId: 5,
      title: 'Facebook',
      url: 'https://www.facebook.com/',
      origin: 'https://www.facebook.com',
      allowedOrigins: [{ scheme: 'https' as const, hostPattern: 'www.facebook.com', includeSubdomains: false }],
      attachedAt: 1,
      updatedAt: Date.now(),
    };
  }

  const openTabCall = (sendCommand: ReturnType<typeof setup>['sendCommand']) =>
    sendCommand.mock.calls.map(([request]) => request).find((request) => request.command === 'open_tab');

  it('opens a separate tab when another Harness session holds the matching tab', async () => {
    const { service, sendCommand } = setup({ connected: [OTHER, MAIN], tabs: [facebookTab(MAIN)] });
    sendCommand.mockImplementation(async (request: BrowserExtensionSendCommandRequest) => {
      if (request.command === 'claim_tab') throw new Error('browser_tab_held_by_another_session');
      return request.command === 'open_tab'
        ? { tab: { tabId: 99, windowId: 5, title: 'Marketplace', url: URL } } : { ok: true };
    });
    const result = await service.findOrOpen({ instanceId: 'i-1', provider: 'codex', url: URL, nodeId: 'node-1' });
    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect(openTabCall(sendCommand)).toMatchObject({ target: { extensionInstanceId: MAIN } });
  });

  it('opens the new tab in the profile agents have used for the website', async () => {
    const { service, sendCommand, auditStore, commandStore } = setup({
      connected: [OTHER, MAIN],
      usage: [
        { extensionInstanceId: MAIN, siteActions: 1948, totalActions: 24_395 },
        { extensionInstanceId: OTHER, siteActions: 3, totalActions: 328 },
      ],
    });

    const result = await service.findOrOpen({ instanceId: 'i-1', provider: 'codex', url: URL, nodeId: 'node-1' });

    expect(commandStore.listRecentExtensionInstances).toHaveBeenCalledWith('node:node-1', true);
    expect(auditStore.countChromeProfileUse).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'node-1',
      origin: 'https://www.facebook.com',
    }));
    expect(openTabCall(sendCommand)).toMatchObject({
      queueKey: 'node:node-1',
      target: { extensionInstanceId: MAIN },
      payload: { url: URL },
    });
    expect(result).toMatchObject({
      outcome: 'succeeded',
      data: { profileId: `existing-tab:n.node-1:p.${MAIN}:5:99`, chromeProfile: '0b779001' },
    });
    expect(result.reason).toContain('chosen because agents have used www.facebook.com there before');
    expect(result.reason).toContain('Other Chrome profiles open on this computer: cfe036dd');
  });

  it('opens in the website profile instead of reusing a tab for the website in another profile', async () => {
    const { service, sendCommand } = setup({
      connected: [MAIN, OTHER],
      usage: [{ extensionInstanceId: MAIN, siteActions: 50, totalActions: 50 }],
      tabs: [facebookTab(OTHER)],
    });

    const result = await service.findOrOpen({ instanceId: 'i-1', provider: 'codex', url: URL, nodeId: 'node-1' });

    expect(openTabCall(sendCommand)).toMatchObject({ target: { extensionInstanceId: MAIN } });
    expect(result.data).toMatchObject({ chromeProfile: '0b779001' });
  });

  it('works in the requested profile, reusing its tab', async () => {
    const tab = facebookTab(OTHER);
    const { service, sendCommand } = setup({
      connected: [MAIN, OTHER],
      usage: [{ extensionInstanceId: MAIN, siteActions: 50, totalActions: 50 }],
      tabs: [facebookTab(MAIN), tab],
    });

    const result = await service.findOrOpen({
      instanceId: 'i-1',
      provider: 'codex',
      url: URL,
      nodeId: 'node-1',
      chromeProfile: 'cfe036dd',
    });

    expect(openTabCall(sendCommand)).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'succeeded', data: { id: tab.targetId, chromeProfile: 'cfe036dd' } });
    expect(result.reason).toContain('this tab is in Chrome profile cfe036dd, as requested');
  });

  it('refuses a requested profile that is not open, before touching Chrome', async () => {
    const { service, sendCommand } = setup({ connected: [MAIN, OTHER] });

    const result = await service.findOrOpen({
      instanceId: 'i-1',
      provider: 'codex',
      url: URL,
      nodeId: 'node-1',
      chromeProfile: 'deadbeef',
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(result.reason).toContain('chrome_profile_not_open');
    expect(result.reason).toContain('0b779001, cfe036dd');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('names the profile when a lost acknowledgement is recovered from inventory', async () => {
    const { service, sendCommand, extensionTabStore } = setup({
      connected: [MAIN, OTHER],
      usage: [{ extensionInstanceId: MAIN, siteActions: 50, totalActions: 50 }],
    });
    const opened = { ...facebookTab(MAIN), url: URL };
    extensionTabStore.listTabs.mockReset();
    extensionTabStore.listTabs.mockReturnValueOnce([]).mockReturnValue([facebookTab(OTHER), opened]);
    sendCommand.mockImplementation(async (request: BrowserExtensionSendCommandRequest) => {
      if (request.command === 'open_tab') {
        throw new Error('browser_extension_command_timeout');
      }
      return { ok: true };
    });

    const result = await service.findOrOpen({ instanceId: 'i-1', provider: 'codex', url: URL, nodeId: 'node-1' });

    expect(result).toMatchObject({ outcome: 'succeeded', data: { id: opened.targetId, chromeProfile: '0b779001' } });
    expect(result.reason).toContain('this tab is in Chrome profile 0b779001');
  });

  it('keeps a single-profile computer exactly as before: unbound open, no profile note', async () => {
    const { service, sendCommand } = setup({
      connected: [MAIN],
      usage: [{ extensionInstanceId: MAIN, siteActions: 5, totalActions: 5 }],
    });

    const result = await service.findOrOpen({ instanceId: 'i-1', provider: 'codex', url: URL, nodeId: 'node-1' });

    expect(openTabCall(sendCommand)).not.toHaveProperty('target');
    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect(result.reason).toBeUndefined();
  });

  it('shows each tab\'s Chrome profile in the agent tab listing', () => {
    const listing = compactAgentTargetListing({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [{ id: 't-1', targetId: 't-1', chromeProfile: '0b779001', title: 'Facebook' }],
    });

    expect(listing.data).toEqual([{ targetId: 't-1', chromeProfile: '0b779001', title: 'Facebook' }]);
  });
});
