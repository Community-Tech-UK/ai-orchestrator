import { describe, expect, it, vi } from 'vitest';
import { makeGrant, makeService } from './browser-gateway-service.test-helpers';

describe('BrowserGatewayService existing Chrome tabs', () => {
  const appStoreConnectTab = {
    profileId: 'existing-tab:7:42',
    targetId: 'existing-tab:7:42:target',
    tabId: 42,
    windowId: 7,
    title: 'App Store Connect',
    url: 'https://appstoreconnect.apple.com/apps',
    origin: 'https://appstoreconnect.apple.com',
    allowedOrigins: [
      {
        scheme: 'https' as const,
        hostPattern: 'appstoreconnect.apple.com',
        includeSubdomains: false,
      },
    ],
  };

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

  it('surfaces a browser approval request instead of denying cross-origin existing-tab navigation', async () => {
    const sendCommand = vi.fn();
    const { approvalRequests, service } = makeService({
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.navigate({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      url: 'https://developer.apple.com/account/resources/identifiers/list',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
      reason: 'cross_origin_navigation_requires_user_approval',
    });
    expect(approvalRequests[0]).toMatchObject({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      toolName: 'browser.navigate',
      action: 'navigate',
      actionClass: 'navigate',
      origin: 'https://developer.apple.com',
      url: 'https://developer.apple.com/account/resources/identifiers/list',
      proposedGrant: {
        mode: 'per_action',
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: 'developer.apple.com',
          includeSubdomains: false,
        }],
        allowedActionClasses: ['navigate'],
        allowExternalNavigation: true,
        autonomous: false,
      },
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('navigates an existing Chrome tab across origins after an approved navigation grant', async () => {
    const sendCommand = vi.fn(async () => ({
      tab: {
        tabId: 42,
        windowId: 7,
        title: 'Certificates, Identifiers & Profiles',
        url: 'https://developer.apple.com/account/resources/identifiers/list',
      },
    }));
    const { audits, service } = makeService({
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: appStoreConnectTab.profileId,
          targetId: appStoreConnectTab.targetId,
          provider: 'claude',
          allowedOrigins: [{
            scheme: 'https',
            hostPattern: 'developer.apple.com',
            includeSubdomains: false,
          }],
          allowedActionClasses: ['navigate'],
          allowExternalNavigation: true,
        }),
      ],
    });

    const result = await service.navigate({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      url: 'https://developer.apple.com/account/resources/identifiers/list',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(audits[0]).toMatchObject({
      grantId: 'grant-1',
      origin: 'https://developer.apple.com',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'navigate',
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        url: 'https://developer.apple.com/account/resources/identifiers/list',
      },
    }));
  });

  it('allows agents to request grants for existing Chrome tabs', async () => {
    const { approvalRequests, service } = makeService({
      existingTab: appStoreConnectTab,
    });

    const result = await service.requestGrant({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      reason: 'Need to open Apple Developer identifiers from App Store Connect',
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: 'developer.apple.com',
          includeSubdomains: false,
        }],
        allowedActionClasses: ['navigate', 'read'],
        allowExternalNavigation: true,
        autonomous: false,
      },
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
      reason: 'Need to open Apple Developer identifiers from App Store Connect',
    });
    expect(approvalRequests[0]).toMatchObject({
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      toolName: 'browser.request_grant',
      action: 'request_grant',
      actionClass: 'navigate',
      origin: appStoreConnectTab.origin,
      url: appStoreConnectTab.url,
      proposedGrant: {
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: 'developer.apple.com',
          includeSubdomains: false,
        }],
      },
    });
  });
});
