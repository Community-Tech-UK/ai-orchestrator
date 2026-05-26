import { describe, expect, it, vi } from 'vitest';
import { makeGrant, makeService } from './browser-gateway-service.test-helpers';

describe('BrowserGatewayService existing Chrome tabs', () => {
  it('executes clicks in existing Chrome tabs through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({ clicked: true }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['input'],
        }),
      ],
    });

    const result = await service.click({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: '#continue',
      actionHint: 'Click continue',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'click',
      target: {
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: '#continue',
      },
    }));
  });

  it('finds an existing Chrome tab by URL before asking the extension to open a new tab', async () => {
    const sendCommand = vi.fn();
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console/u/0/developers',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://play.google.com/console',
      titleHint: 'Play Console',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        profileId: existingTab.profileId,
        id: existingTab.targetId,
        driver: 'extension',
      },
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
