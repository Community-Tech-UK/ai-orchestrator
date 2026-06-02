import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  const appleDeveloperTab = {
    ...appStoreConnectTab,
    title: 'Certificates, Identifiers & Profiles',
    url: 'https://developer.apple.com/account/resources/identifiers/list',
    origin: 'https://developer.apple.com',
    allowedOrigins: [
      {
        scheme: 'https' as const,
        hostPattern: 'developer.apple.com',
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

  it('uploads files in existing Chrome tabs through the extension command bridge after upload approval', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-'));
    const filePath = path.join(tempDir, 'app.ipa');
    fs.writeFileSync(filePath, 'fake app');
    const resolvedFilePath = fs.realpathSync(filePath);
    const sendCommand = vi.fn(async () => ({ uploaded: true, selector: 'input[type=file]' }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'App Store Connect',
      url: 'https://appstoreconnect.apple.com/apps',
      origin: 'https://appstoreconnect.apple.com',
      allowedOrigins: appStoreConnectTab.allowedOrigins,
    };
    const { driver, service } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [tempDir],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Upload app binary',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.uploadFile).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'upload_file',
      payload: {
        selector: 'input[type=file]',
        filePath: resolvedFilePath,
      },
    }));
  });

  it('downloads files in existing Chrome tabs through the extension and returns the completed file record', async () => {
    const sendCommand = vi.fn(async () => ({
      id: 14,
      url: 'https://appstoreconnect.apple.com/download/report.csv',
      finalUrl: 'https://appstoreconnect.apple.com/download/report.csv',
      filename: '/Users/james/Downloads/report.csv',
      mime: 'text/csv',
      bytesReceived: 128,
      totalBytes: 128,
      state: 'complete',
      startedAt: '2026-06-02T10:00:00.000Z',
      endedAt: '2026-06-02T10:00:01.000Z',
    }));
    const { service } = makeService({
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: appStoreConnectTab.profileId,
          targetId: appStoreConnectTab.targetId,
          provider: 'claude',
          allowedOrigins: appStoreConnectTab.allowedOrigins,
          allowedActionClasses: ['file-download'],
        }),
      ],
    });

    const result = await service.downloadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      selector: 'a.download',
      actionHint: 'Download report',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        filename: '/Users/james/Downloads/report.csv',
        state: 'complete',
        bytesReceived: 128,
      },
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'download_file',
      payload: {
        selector: 'a.download',
        timeoutMs: 60_000,
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

  it('captures a fresh existing-tab snapshot through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      title: 'Certificates, Identifiers & Profiles',
      url: 'https://developer.apple.com/account/resources/identifiers/list',
      text: 'token=abc123 Identifiers App IDs',
    }));
    const { extensionTabStore, service } = makeService({
      existingTab: {
        ...appleDeveloperTab,
        title: 'Stale Developer Portal',
        text: 'stale cache',
      },
      extensionCommandStore: { sendCommand },
    });

    const result = await service.snapshot({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appleDeveloperTab.profileId,
      targetId: appleDeveloperTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        title: 'Certificates, Identifiers & Profiles',
        url: 'https://developer.apple.com/account/resources/identifiers/list',
        text: 'token=[REDACTED] Identifiers App IDs',
      },
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'snapshot',
      target: {
        profileId: appleDeveloperTab.profileId,
        targetId: appleDeveloperTab.targetId,
        tabId: 42,
        windowId: 7,
      },
    }));
    expect(extensionTabStore.attachTab).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Certificates, Identifiers & Profiles',
      text: 'token=abc123 Identifiers App IDs',
    }));
  });

  it('captures a fresh existing-tab screenshot instead of requiring cached attachment data', async () => {
    const sendCommand = vi.fn(async () => ({
      screenshotBase64: 'ZnJlc2gtcG5n',
      capturedAt: 1_700_000_000_000,
    }));
    const { service } = makeService({
      existingTab: {
        ...appStoreConnectTab,
        screenshotBase64: undefined,
      },
      extensionCommandStore: { sendCommand },
    });

    const result = await service.screenshot({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: 'ZnJlc2gtcG5n',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'screenshot',
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
    }));
  });

  it('waits for selectors in existing Chrome tabs through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({
      tagName: 'BUTTON',
      text: 'New App',
    }));
    const { driver, service } = makeService({
      profile: null,
      profiles: [],
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.waitFor({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      selector: 'button[aria-label="New App"]',
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.waitFor).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'wait_for',
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: 'button[aria-label="New App"]',
        timeoutMs: 5_000,
      },
    }));
  });

  it('queries selector candidates in existing Chrome tabs through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({
      elements: [{
        selector: 'button[aria-label="New App"]',
        tagName: 'BUTTON',
        role: 'button',
        accessibleName: 'New App',
        text: '',
      }],
    }));
    const { driver, service } = makeService({
      profile: null,
      profiles: [],
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.queryElements({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      query: 'New App',
      limit: 10,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [{
        selector: 'button[aria-label="New App"]',
        tagName: 'BUTTON',
        accessibleName: 'New App',
      }],
    });
    expect(driver.waitFor).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'query_elements',
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        query: 'New App',
        limit: 10,
      },
    }));
  });
});
