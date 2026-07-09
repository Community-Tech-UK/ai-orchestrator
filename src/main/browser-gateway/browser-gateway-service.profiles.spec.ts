import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { stopBrowserCampaignRuntime } from './browser-campaign-runtime';
import { makeService, makeTarget } from './browser-gateway-service.test-helpers';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';

describe('BrowserGatewayService profiles', () => {
  afterEach(() => {
    BrowserGatewayService._resetForTesting();
    stopBrowserCampaignRuntime();
    WorkerNodeRegistry._resetForTesting();
  });

  it('returns an actionable bootstrap reason when no managed profiles exist', async () => {
    const { service } = makeService({ profile: null, profiles: [] });

    await expect(service.listProfiles({
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: 'no_managed_profiles_configured_use_browser_find_or_open_or_share_current_tab',
      data: [],
    });
  });

  it('allows providers to create managed profiles without exposing profile paths', async () => {
    const { service, audits, profileRegistry } = makeService();

    const result = await service.createProfile({
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: true,
        },
      ],
      defaultUrl: 'https://play.google.com/console',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    expect(profileRegistry.createProfile).toHaveBeenCalledWith({
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: true,
        },
      ],
      defaultUrl: 'https://play.google.com/console',
    });
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        label: 'Google Play',
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: true,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('debugEndpoint');
    expect(audits[0]).toMatchObject({
      provider: 'claude',
      action: 'create_profile',
      toolName: 'browser.create_profile',
    });
  });

  it('attaches a selected existing Chrome tab and audits it as an extension target', async () => {
    const { service, extensionTabStore } = makeService();

    const result = await service.attachExistingTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
      text: 'Release dashboard',
      screenshotBase64: 'cG5n',
      capturedAt: 1000,
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    });

    expect(extensionTabStore.attachTab).toHaveBeenCalledWith(
      {
        tabId: 42,
        windowId: 7,
        url: 'https://play.google.com/console',
        title: 'Google Play Console',
        text: 'Release dashboard',
        screenshotBase64: 'cG5n',
        capturedAt: 1000,
        extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      },
      {
        nodeId: undefined,
        nodeName: undefined,
      },
    );
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        id: 'existing-tab:7:42:target',
        profileId: 'existing-tab:7:42',
        mode: 'existing-tab',
        driver: 'extension',
      },
    });
    expect(JSON.stringify(result)).not.toContain('driverTargetId');
  });

  it('recovers a timed-out open_tab as success when the post-timeout probe finds the tab', async () => {
    const sendCommand = vi.fn(async (request: { command: string }) => {
      if (request.command === 'open_tab') {
        throw new Error('browser_extension_command_timeout');
      }
      return { ok: true }; // report_inventory probe
    });
    const { service, extensionTabStore } = makeService({
      existingTab: {
        profileId: 'existing-tab:7:99',
        targetId: 'existing-tab:7:99:target',
        tabId: 99,
        windowId: 7,
        title: 'ProContract',
        url: 'https://procontract.due-north.com/Login',
        origin: 'https://procontract.due-north.com',
        allowedOrigins: [{
          scheme: 'https' as const,
          hostPattern: 'procontract.due-north.com',
          includeSubdomains: false,
        }],
      },
      extensionCommandStore: { sendCommand },
    });
    // No matching tab before the open attempt; the tab appears once the
    // recovery probe refreshes inventory (the open actually worked — only the
    // ack was lost).
    extensionTabStore.listTabs.mockReturnValueOnce([]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'claude',
      url: 'https://procontract.due-north.com/Login',
    });

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'open_tab' }));
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'report_inventory' }));
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        id: 'existing-tab:7:99:target',
        profileId: 'existing-tab:7:99',
      },
    });
  });

  it('reads cached snapshots and screenshots from selected existing Chrome tabs', async () => {
    const { service, driver } = makeService({
      profile: null,
      profiles: [],
      target: makeTarget({
        id: 'existing-tab:7:42:target',
        profileId: 'existing-tab:7:42',
        mode: 'existing-tab',
        driver: 'extension',
        url: 'https://play.google.com/console',
        origin: 'https://play.google.com',
      }),
      existingTab: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        title: 'Google Play Console',
        url: 'https://play.google.com/console',
        origin: 'https://play.google.com',
        text: 'token=abc123 release dashboard',
        screenshotBase64: 'cG5n',
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: false,
          },
        ],
      },
    });

    await expect(service.snapshot({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        title: 'Google Play Console',
        url: 'https://play.google.com/console',
        text: 'token=[REDACTED] release dashboard',
      },
    });
    await expect(service.screenshot({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: 'cG5n',
    });
    expect(driver.snapshot).not.toHaveBeenCalled();
    expect(driver.screenshot).not.toHaveBeenCalled();
  });
});
