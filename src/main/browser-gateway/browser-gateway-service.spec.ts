import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { makeGrant, makeProfile, makeService, makeTarget } from './browser-gateway-service.test-helpers';
import { getWorkerNodeRegistry, WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';

describe('BrowserGatewayService', () => {
  afterEach(() => {
    BrowserGatewayService._resetForTesting();
    WorkerNodeRegistry._resetForTesting();
  });

  function makeRelayNode(id = 'node-1', name = 'Windows PC'): WorkerNodeInfo {
    return {
      id,
      name,
      address: '127.0.0.1',
      status: 'connected',
      activeInstances: 0,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: true,
        hasExtensionRelay: true,
        extensionRelay: {
          enabled: true,
          running: true,
        },
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 2,
        workingDirectories: [],
        browsableRoots: [],
        discoveredProjects: [],
      },
    };
  }

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

  it('allows navigation within policy, calls the driver, and audits success', async () => {
    const { service, audits, driver } = makeService();

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567/next',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      auditId: 'audit-1',
    });
    expect(driver.navigate).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'http://localhost:4567/next',
    );
    expect(audits[0]).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      action: 'navigate',
      toolName: 'browser.navigate',
    });
  });

  it('downloads files from managed profiles through the driver under a download grant', async () => {
    const { service, driver } = makeService({
      grants: [
        makeGrant({
          allowedActionClasses: ['file-download'],
        }),
      ],
    });
    driver.downloadFile.mockResolvedValue({
      id: 'download-1',
      url: 'http://localhost:4567/report.csv',
      finalUrl: 'http://localhost:4567/report.csv',
      filename: '/tmp/browser-profiles/profile-1/Downloads/report.csv',
      mime: 'text/csv',
      bytesReceived: 42,
      totalBytes: 42,
      state: 'complete',
    });

    const result = await service.downloadFile({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'a.download',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        filename: '/tmp/browser-profiles/profile-1/Downloads/report.csv',
        state: 'complete',
      },
    });
    expect(driver.downloadFile).toHaveBeenCalledWith('profile-1', 'target-1', {
      selector: 'a.download',
      timeoutMs: 60_000,
    });
  });

  it('denies direct download URLs outside the approved grant origins', async () => {
    const { service, driver } = makeService({
      grants: [
        makeGrant({
          allowedActionClasses: ['file-download'],
        }),
      ],
    });

    const result = await service.downloadFile({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'https://example.com/report.csv',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'download_url_origin_not_allowed',
    });
    expect(driver.downloadFile).not.toHaveBeenCalled();
  });

  it('denies opening a profile when its default URL is outside allowed origins', async () => {
    const { service, driver } = makeService({
      profile: makeProfile({
        defaultUrl: 'https://example.com/outside',
      }),
    });

    const result = await service.openProfile({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
    });
    expect(driver.openProfile).not.toHaveBeenCalled();
  });

  it('passes the resolved preferred debug port to the driver when opening a profile', async () => {
    const { service, driver } = makeService({
      resolvePreferredDebugPort: (profileId) => (profileId === 'profile-1' ? 31234 : undefined),
    });

    const result = await service.openProfile({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    const call = driver.openProfile.mock.calls[0];
    expect(call[0]).toMatchObject({ id: 'profile-1' });
    expect(call[2]).toBe(31234);
  });

  it('passes undefined debug port to the driver when no attach resolver is configured', async () => {
    const { service, driver } = makeService();

    await service.openProfile({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    const call = driver.openProfile.mock.calls[0];
    expect(call[0]).toMatchObject({ id: 'profile-1' });
    expect(call[2]).toBeUndefined();
  });

  it('denies blocked navigation without calling the driver', async () => {
    const { service, audits, driver } = makeService();

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'https://example.com',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
      auditId: 'audit-1',
    });
    expect(driver.navigate).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
    });
  });

  it('denies screenshots when the current target origin is blocked', async () => {
    const { service, driver } = makeService({
      target: makeTarget({
        url: 'https://example.com',
        origin: 'https://example.com',
      }),
    });

    const result = await service.screenshot({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
    });
    expect(driver.screenshot).not.toHaveBeenCalled();
  });

  it('refreshes live target state before read operations so stale allowed URLs cannot leak blocked pages', async () => {
    const { service, driver } = makeService({
      target: makeTarget({
        url: 'http://localhost:4567/stale',
        origin: 'http://localhost:4567',
      }),
      refreshTarget: async () => makeTarget({
        url: 'https://example.com/live',
        origin: 'https://example.com',
      }),
    });

    const result = await service.screenshot({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
    });
    expect(driver.refreshTarget).toHaveBeenCalledWith('profile-1', 'target-1');
    expect(driver.screenshot).not.toHaveBeenCalled();
  });

  it('marks listed remote extension targets stale when their node has no recent contact', async () => {
    const { service } = makeService({
      target: makeTarget({
        id: 'existing-tab:n.node-1:7:42:target',
        profileId: 'existing-tab:n.node-1:7:42',
        nodeId: 'node-1',
        nodeName: 'Windows PC',
        mode: 'existing-tab',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 1_000,
      }),
      extensionContactState: {
        getLastExtensionContactAt: () => 500,
        isExtensionContactFresh: () => false,
        describeExtensionContact: (nodeId) => ({
          nodeId,
          lastContactAt: 500,
          silent: true,
          staleForMs: 120_000,
        }),
      },
    });

    const result = await service.listTargets({ nodeId: 'node-1' });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [{
        id: 'existing-tab:n.node-1:7:42:target',
        nodeId: 'node-1',
        lastSeenAt: 1_000,
        stale: true,
      }],
    });
  });

  it('queues a bounded remote inventory refresh before returning refreshed target listings', async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const { service } = makeService({
      target: makeTarget({
        id: 'existing-tab:n.node-1:7:42:target',
        profileId: 'existing-tab:n.node-1:7:42',
        nodeId: 'node-1',
        nodeName: 'Windows PC',
        mode: 'existing-tab',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 1_000,
      }),
      extensionCommandStore: { sendCommand },
    });

    const result = await service.listTargets({ nodeId: 'node-1', refresh: true });

    expect(sendCommand).toHaveBeenCalledWith({
      queueKey: 'node:node-1',
      command: 'report_inventory',
      timeoutMs: 3_000,
      executionTimeoutMs: 2_500,
    });
    expect(result.data).toEqual([
      expect.objectContaining({
        id: 'existing-tab:n.node-1:7:42:target',
        nodeId: 'node-1',
      }),
    ]);
  });

  it('returns targets reported during the requested inventory refresh', async () => {
    const refreshedTarget = makeTarget({
      id: 'existing-tab:7:43:target',
      profileId: 'existing-tab:7:43',
      pageId: '43',
      driverTargetId: 'chrome-tab:7:43',
      mode: 'existing-tab',
      driver: 'extension',
      status: 'selected',
      title: 'Fresh shared tab',
      url: 'https://app.emergent.sh/home',
      origin: 'https://app.emergent.sh',
      lastSeenAt: 2_000,
    });
    let listCalls = 0;
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const { service } = makeService({
      targets: () => {
        listCalls += 1;
        return listCalls === 1 ? [] : [refreshedTarget];
      },
      extensionCommandStore: { sendCommand },
    });

    const result = await service.listTargets({ refresh: true });

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'local',
      command: 'report_inventory',
    }));
    expect(result.data).toEqual([
      expect.objectContaining({
        id: refreshedTarget.id,
        profileId: refreshedTarget.profileId,
        url: 'https://app.emergent.sh/home',
      }),
    ]);
  });

  it('refreshes only the local extension queue when the requested computer is local', async () => {
    getWorkerNodeRegistry().registerNode(makeRelayNode());
    const localTarget = makeTarget({
      id: 'existing-tab:7:42:target',
      profileId: 'existing-tab:7:42',
      pageId: '42',
      driverTargetId: 'chrome-tab:7:42',
      mode: 'existing-tab',
      driver: 'extension',
      status: 'selected',
      title: 'Local tab',
      url: 'https://app.emergent.sh/home',
      origin: 'https://app.emergent.sh',
    });
    const remoteTarget = makeTarget({
      id: 'existing-tab:n.node-1:8:99:target',
      profileId: 'existing-tab:n.node-1:8:99',
      pageId: '99',
      driverTargetId: 'chrome-tab:8:99',
      mode: 'existing-tab',
      driver: 'extension',
      status: 'selected',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      title: 'Windows tab',
      url: 'https://app.emergent.sh/home',
      origin: 'https://app.emergent.sh',
    });
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const { service } = makeService({
      targets: [localTarget, remoteTarget],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.listTargets({ refresh: true, computer: 'local' });

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'local',
      command: 'report_inventory',
    }));
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]).toMatchObject({ id: localTarget.id });
    expect(result.data?.[0]).not.toHaveProperty('nodeId');
  });

  it('marks targets stale and says so when an explicit inventory refresh fails', async () => {
    // The channel can look "fresh" (recent contact) while the live refresh
    // still fails — cached tabs must NOT read as proof the extension is alive.
    const sendCommand = vi.fn(async () => {
      throw new Error('browser_extension_command_not_delivered');
    });
    const { service } = makeService({
      target: makeTarget({
        id: 'existing-tab:n.node-1:7:42:target',
        profileId: 'existing-tab:n.node-1:7:42',
        nodeId: 'node-1',
        nodeName: 'Windows PC',
        mode: 'existing-tab',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 1_000,
      }),
      extensionCommandStore: { sendCommand },
    });

    const result = await service.listTargets({ nodeId: 'node-1', refresh: true });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: expect.stringContaining('inventory refresh FAILED') as string,
      data: [expect.objectContaining({
        id: 'existing-tab:n.node-1:7:42:target',
        stale: true,
      })],
    });
  });

  it('does not report a local refresh failure when no local extension targets exist', async () => {
    // Machines with no local extension set up must not see "refresh FAILED for
    // the local extension" on every refreshed listing — the local queue is
    // probed unconditionally, so its failure is only news when local cached
    // targets exist.
    const sendCommand = vi.fn(async () => {
      throw new Error('browser_extension_command_not_delivered');
    });
    const { service } = makeService({
      target: makeTarget({
        id: 'existing-tab:n.node-1:7:42:target',
        profileId: 'existing-tab:n.node-1:7:42',
        nodeId: 'node-1',
        nodeName: 'Windows PC',
        mode: 'existing-tab',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 1_000,
      }),
      extensionCommandStore: { sendCommand },
    });

    // No nodeId filter and an empty worker registry: the refresh probes only
    // the local queue, and that probe fails.
    const result = await service.listTargets({ refresh: true });

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'local',
      command: 'report_inventory',
    }));
    // The local failure is masked (no local extension targets exist), so the
    // listing reports nothing degraded and the node target stays non-stale.
    expect(result.reason).toBeUndefined();
    expect(result.data?.[0]).not.toHaveProperty('stale');
  });

  it('records requires_user for mutating browser actions', async () => {
    const { service, audits } = makeService();

    const result = await service.requireUserForMutatingAction({
      toolName: 'browser.click',
      action: 'click',
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      auditId: 'audit-1',
    });
    expect(audits[0]).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      actionClass: 'input',
    });
  });

  it('creates an approval request for ungranted click without executing the driver', async () => {
    const { service, driver, approvalStore, approvalRequests } = makeService();

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
    });
    expect(driver.click).not.toHaveBeenCalled();
    expect(approvalStore.createRequest).toHaveBeenCalledOnce();
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'input',
      selector: 'button.continue',
      status: 'pending',
    });
  });

  it('auto-approves ungranted browser actions for YOLO instances', async () => {
    const { service, driver, approvalStore, grants } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.continue');
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      allowedActionClasses: ['input'],
      autonomous: false,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('auto-approves submit-classified actions for YOLO instances with a usable autonomous grant', async () => {
    const { service, driver, grants, approvalRequests } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });
    driver.inspectElement.mockResolvedValueOnce({
      role: 'button',
      accessibleName: 'Save changes',
    });

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.save',
      instanceId: 'instance-1',
      provider: 'codex',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.save');
    // The auto-approved grant must be autonomous or the submit-class recheck
    // would immediately reject it and re-prompt the user despite yolo.
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      allowedActionClasses: ['submit'],
      autonomous: true,
    });
    expect(approvalRequests).toHaveLength(1);
  });

  it('creates a usable grant when the user approves a submit action per_action', async () => {
    const { service, driver, grants, approvalRequests } = makeService();
    driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Save changes',
    });

    const first = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.save',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    expect(first).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
    });

    // Approve with the dialog default: the proposed per_action grant.
    await service.approveRequest({
      requestId: approvalRequests[0].requestId,
      grant: approvalRequests[0].proposedGrant,
      reason: 'Approved from session page',
    });
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      allowedActionClasses: ['submit'],
      autonomous: true,
    });

    const retry = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.save',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    expect(retry).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.save');
  });

  it('auto-approves a grant change between preparation and execution for YOLO instances', async () => {
    const grant = makeGrant({ mode: 'per_action' });
    const { service, driver, grantStore, approvalStore } = makeService({
      grants: [grant],
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });
    // First lookup (preparation) sees the grant; every later lookup (the
    // pre-execution recheck) sees it gone, simulating a revocation race.
    grantStore.listGrants
      .mockImplementationOnce(() => [grant])
      .mockImplementation(() => []);

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.continue');
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-2',
    });
  });

  it('installs auto-approval when the singleton already exists before runtime initialization', async () => {
    BrowserGatewayService._resetForTesting();
    const { service, driver, approvalStore, grants } = makeService({
      useSingleton: true,
    });

    BrowserGatewayService.initialize({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.continue');
    expect(grants[0]).toMatchObject({
      instanceId: 'instance-1',
      allowedActionClasses: ['input'],
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('redacts element context before storing approval requests', async () => {
    const { service, driver, approvalRequests } = makeService();
    driver.inspectElement.mockResolvedValueOnce({
      role: 'input',
      accessibleName: 'Token',
      visibleText: 'token=abc123',
      inputName: 'api_token',
      attributes: {
        value: 'abc123',
        'data-token': 'secret-token',
        'data-safe': 'safe-value',
      },
    });

    await service.type({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'input[name="api_token"]',
      value: 'ignored',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(approvalRequests[0]?.elementContext).toMatchObject({
      visibleText: 'token=[REDACTED]',
      attributes: {
        value: '[REDACTED]',
        'data-token': '[REDACTED]',
        'data-safe': 'safe-value',
      },
    });
    expect(JSON.stringify(approvalRequests[0])).not.toContain('abc123');
    expect(JSON.stringify(approvalRequests[0])).not.toContain('secret-token');
  });

  it('executes click under a matching session grant and audits the grant id', async () => {
    const { service, driver, audits } = makeService({
      grants: [makeGrant()],
    });

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.continue');
    expect(audits.at(-1)).toMatchObject({
      grantId: 'grant-1',
      autonomous: false,
      action: 'click',
    });
  });

  it('requires explicit autonomous submit grant for submit-like clicks', async () => {
    const submitGrant = makeGrant({
      mode: 'autonomous',
      autonomous: true,
      allowedActionClasses: ['input', 'submit'],
    });
    const { service, driver } = makeService({
      grants: [submitGrant],
    });
    driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Submit for review',
    });

    await expect(service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.submit',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalled();

    const blocked = makeService({
      grants: [
        makeGrant({
          mode: 'autonomous',
          autonomous: true,
          allowedActionClasses: ['input'],
        }),
      ],
    });
    blocked.driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Submit for review',
    });
    await expect(blocked.service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.submit',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
    });
    expect(blocked.driver.click).not.toHaveBeenCalled();
  });

  it('consumes per-action grants after one execution', async () => {
    const { service, grantStore } = makeService({
      grants: [makeGrant({ mode: 'per_action' })],
    });

    await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(grantStore.consumeGrant).toHaveBeenCalledWith('grant-1');
  });

  it('re-checks the grant immediately before mutating driver execution', async () => {
    const activeGrant = makeGrant();
    const { service, driver, grantStore } = makeService({
      grants: [activeGrant],
    });
    grantStore.listGrants
      .mockReturnValueOnce([activeGrant])
      .mockReturnValueOnce([]);

    await expect(service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: 'no_matching_grant',
    });
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('refreshes live target state before mutating actions so stale allowed URLs cannot authorize blocked pages', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
      refreshTarget: async () => makeTarget({
        url: 'https://example.com/live',
        origin: 'https://example.com',
      }),
    });

    await expect(service.type({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'input[name="title"]',
      value: 'Release notes',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
    });
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('audits mutating driver failures as failed Browser Gateway results', async () => {
    const { service, driver, audits } = makeService({
      grants: [makeGrant()],
    });
    driver.type.mockRejectedValueOnce(new Error('type failed'));

    const result = await service.type({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'input[name="title"]',
      value: 'Release notes',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'type failed',
    });
    expect(audits.at(-1)).toMatchObject({
      action: 'type',
      toolName: 'browser.type',
      decision: 'allowed',
      outcome: 'failed',
      grantId: 'grant-1',
    });
  });

  it('turns element inspection failures into requires_user instead of raw driver errors', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    driver.inspectElement.mockRejectedValueOnce(new Error('selector missing'));

    await expect(service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.missing',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: 'element_context_unavailable',
    });
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('executes type, select, fill_form, and upload_file under matching grants', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-gateway-upload-'));
    const uploadRoot = path.join(tempDir, 'uploads');
    fs.mkdirSync(uploadRoot);
    const uploadFile = path.join(uploadRoot, 'app.aab');
    fs.writeFileSync(uploadFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const resolvedUploadFile = fs.realpathSync(uploadFile);
    const { service, driver } = makeService({
      profile: makeProfile({
        userDataDir: path.join(tempDir, 'userData', 'browser-profiles', 'profile-1'),
      }),
      grants: [
        makeGrant({
          allowedActionClasses: ['input', 'file-upload'],
          uploadRoots: [uploadRoot],
        }),
      ],
    });

    try {
      await service.type({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[name="title"]',
        value: 'Release notes',
        instanceId: 'instance-1',
        provider: 'copilot',
      });
      await service.select({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'select.track',
        value: 'production',
        instanceId: 'instance-1',
        provider: 'copilot',
      });
      await service.fillForm({
        profileId: 'profile-1',
        targetId: 'target-1',
        fields: [
          { selector: '#one', value: 'One' },
          { selector: '#two', value: 'Two' },
        ],
        instanceId: 'instance-1',
        provider: 'copilot',
      });
      await service.uploadFile({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[type="file"]',
        filePath: uploadFile,
        instanceId: 'instance-1',
        provider: 'copilot',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    expect(driver.type).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'input[name="title"]',
      'Release notes',
    );
    expect(driver.select).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'select.track',
      'production',
    );
    expect(driver.fillForm).toHaveBeenCalledWith('profile-1', 'target-1', [
      { selector: '#one', value: 'One' },
      { selector: '#two', value: 'Two' },
    ]);
    expect(driver.uploadFile).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'input[type="file"]',
      resolvedUploadFile,
    );
  });

  it('fails verified click when read-back does not match the expectation', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    driver.readControl.mockResolvedValueOnce({ checked: false });

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: '#terms',
      verify: { checked: true },
      instanceId: 'instance-1',
      provider: 'copilot',
    } as any);

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: expect.stringContaining('browser_verify_mismatch') as string,
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', '#terms');
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', '#terms');
  });

  it('fails verified select when selected label read-back does not match', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    driver.readControl.mockResolvedValueOnce({ value: 'internal', selectedLabel: 'Internal' });

    const result = await service.select({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'select.track',
      value: 'production',
      verify: { selectedLabel: 'Production' },
      instanceId: 'instance-1',
      provider: 'copilot',
    } as any);

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: expect.stringContaining('browser_verify_mismatch') as string,
    });
    expect(driver.select).toHaveBeenCalledWith('profile-1', 'target-1', 'select.track', 'production');
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', 'select.track');
  });

  it('fails verified fill_form when any field read-back does not match', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    driver.readControl
      .mockResolvedValueOnce({ value: 'One' })
      .mockResolvedValueOnce({ value: 'wrong' });

    const result = await service.fillForm({
      profileId: 'profile-1',
      targetId: 'target-1',
      fields: [
        { selector: '#one', value: 'One', verify: { value: 'One' } },
        { selector: '#two', value: 'Two', verify: { value: 'Two' } },
      ],
      instanceId: 'instance-1',
      provider: 'copilot',
    } as any);

    expect(driver.fillForm).toHaveBeenCalledWith('profile-1', 'target-1', [
      { selector: '#one', value: 'One' },
      { selector: '#two', value: 'Two' },
    ]);
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', '#one');
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', '#two');
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: expect.stringContaining('browser_verify_mismatch') as string,
    });
  });

  it('blocks fill_form atomically when a field is credential-like', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant({ allowedActionClasses: ['input', 'credential'] })],
    });
    driver.inspectElement
      .mockResolvedValueOnce({ label: 'Title', inputType: 'text' })
      .mockResolvedValueOnce({ label: 'Password', inputType: 'password' });

    await expect(service.fillForm({
      profileId: 'profile-1',
      targetId: 'target-1',
      fields: [
        { selector: '#title', value: 'Title' },
        { selector: '#password', value: 'secret' },
      ],
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
    });
    expect(driver.fillForm).not.toHaveBeenCalled();
  });

  it('creates grant requests and returns approval status scoped to the instance', async () => {
    const { service, approvalRequests } = makeService();

    const requestResult = await service.requestGrant({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['input'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      reason: 'overnight form filling',
    });

    expect(requestResult).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
    });
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.request_grant',
      status: 'pending',
      proposedGrant: {
        mode: 'session',
        allowedActionClasses: ['input'],
      },
    });

    await expect(service.getApprovalStatus({
      requestId: 'request-1',
      instanceId: 'other-instance',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'approval_request_not_found',
    });
    await expect(service.getApprovalStatus({
      requestId: 'request-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: {
        requestId: 'request-1',
        status: 'pending',
      },
    });
  });

  it('auto-approves explicit browser grant requests for YOLO instances', async () => {
    const { service, approvalStore, grants } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const result = await service.requestGrant({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      proposedGrant: {
        mode: 'autonomous',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['read', 'navigate', 'input'],
        allowExternalNavigation: false,
        autonomous: true,
      },
      reason: 'overnight form filling',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(grants[0]).toMatchObject({
      mode: 'autonomous',
      instanceId: 'instance-1',
      provider: 'copilot',
      allowedActionClasses: ['read', 'navigate', 'input'],
      autonomous: true,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('creates user-login approval requests without exposing credential entry to agents', async () => {
    const { service, approvalRequests } = makeService();

    const result = await service.requestUserLogin({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      reason: 'Google Play Console requires a fresh sign-in.',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
      reason: 'manual_login_required',
    });
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.request_user_login',
      action: 'request_user_login',
      actionClass: 'credential',
      elementContext: {
        nearbyText: 'Google Play Console requires a fresh sign-in.',
      },
      proposedGrant: {
        mode: 'per_action',
        allowedActionClasses: ['read'],
        autonomous: false,
      },
    });
  });

  it('auto-approves manual handoff requests for YOLO instances without surfacing a prompt', async () => {
    const { service, approvalStore, grants, profileStore } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const login = await service.requestUserLogin({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      reason: 'Sign in required.',
    });
    expect(login).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: 'auto_approved_by_yolo_mode',
    });
    expect('requestId' in login).toBe(false);
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      provider: 'claude',
      allowedActionClasses: ['read'],
      autonomous: false,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
    expect(profileStore.setRuntimeState).toHaveBeenCalledWith('profile-1', {
      lastLoginCheckAt: expect.any(Number),
    });

    const manualStep = await service.pauseForManualStep({
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'two_factor',
      instanceId: 'instance-1',
      provider: 'claude',
      reason: 'Enter the authenticator code.',
    });
    expect(manualStep).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: 'auto_approved_by_yolo_mode',
    });
    expect('requestId' in manualStep).toBe(false);
    expect(grants[1]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      provider: 'claude',
      allowedActionClasses: ['read'],
      autonomous: false,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-2', {
      status: 'approved',
      grantId: 'grant-2',
    });
  });

  it('auto-resolves stale pending browser approvals when YOLO is enabled before listing', async () => {
    BrowserGatewayService._resetForTesting();
    const { service, approvalStore, grants } = makeService({
      useSingleton: true,
    });

    const pending = await service.pauseForManualStep({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'codex',
      reason: 'Refresh the shared tab.',
    });
    expect(pending).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
    });

    BrowserGatewayService.initialize({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const listed = await service.listApprovalRequests({
      instanceId: 'instance-1',
      status: 'pending',
    });
    expect(listed).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [],
    });
    expect(grants[0]).toMatchObject({
      id: 'grant-1',
      instanceId: 'instance-1',
      provider: 'codex',
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });

    await expect(service.getApprovalStatus({
      requestId: 'request-1',
      instanceId: 'instance-1',
      provider: 'codex',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: {
        requestId: 'request-1',
        status: 'approved',
        grantId: 'grant-1',
      },
    });
  });

  it('creates manual-step approval requests for captcha and two-factor pauses', async () => {
    const { service, approvalRequests } = makeService();

    await expect(service.pauseForManualStep({
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'two_factor',
      reason: 'Enter the authenticator code displayed on the device.',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: 'manual_step_required',
    });
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.pause_for_manual_step',
      action: 'pause_for_manual_step',
      actionClass: 'credential',
      elementContext: {
        nearbyText: 'Enter the authenticator code displayed on the device.',
      },
      proposedGrant: {
        allowedActionClasses: ['read'],
      },
    });
  });

  it('approves pending requests into bounded grants and resolves the approval request', async () => {
    const { service, approvalStore, grants } = makeService();
    await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    const result = await service.approveRequest({
      requestId: 'request-1',
      grant: {
        mode: 'autonomous',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['input', 'submit'],
        allowExternalNavigation: false,
        autonomous: true,
      },
      reason: 'approved overnight run',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      data: {
        id: 'grant-1',
        mode: 'autonomous',
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'target-1',
      },
    });
    expect(grants[0].expiresAt - grants[0].createdAt).toBeLessThanOrEqual(86_400_000);
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('updates last login check time when a user-login approval is approved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const { service, profileStore } = makeService();
    await service.requestUserLogin({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    await service.approveRequest({
      requestId: 'request-1',
      grant: {
        mode: 'per_action',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['read'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    });

    expect(profileStore.setRuntimeState).toHaveBeenCalledWith('profile-1', {
      lastLoginCheckAt: 5_000,
    });
    vi.useRealTimers();
  });

  it('lists and revokes active grants through the service', async () => {
    const grant = makeGrant({ id: 'grant-active' });
    const { service, grantStore } = makeService({ grants: [grant] });

    await expect(service.listGrants({
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: [
        {
          id: 'grant-active',
        },
      ],
    });
    await expect(service.revokeGrant({
      grantId: 'grant-active',
      reason: 'user stopped the run',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: {
        id: 'grant-active',
        revokedAt: expect.any(Number),
      },
    });
    expect(grantStore.revokeGrant).toHaveBeenCalledWith('grant-active', 'user stopped the run');
  });

  it('validates upload paths against grant roots before calling the driver', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-gateway-upload-'));
    try {
      const allowedRoot = path.join(tempDir, 'allowed');
      const deniedRoot = path.join(tempDir, 'denied');
      fs.mkdirSync(allowedRoot);
      fs.mkdirSync(deniedRoot);
      const deniedFile = path.join(deniedRoot, 'release.zip');
      fs.writeFileSync(deniedFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const { service, driver, approvalRequests } = makeService({
        profile: makeProfile({
          userDataDir: path.join(tempDir, 'userData', 'browser-profiles', 'profile-1'),
        }),
        grants: [
          makeGrant({
            allowedActionClasses: ['file-upload'],
            uploadRoots: [allowedRoot],
          }),
        ],
      });

      await expect(service.uploadFile({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[type="file"]',
        filePath: deniedFile,
        instanceId: 'instance-1',
        provider: 'copilot',
      })).resolves.toMatchObject({
        decision: 'requires_user',
        outcome: 'not_run',
        reason: 'root_not_allowed',
      });
      expect(approvalRequests[0]?.filePath).toBe(fs.realpathSync(deniedFile));
      expect(approvalRequests[0]?.detectedFileType).toBe('application/zip');
      expect(approvalRequests[0]?.proposedGrant.uploadRoots).toContain(
        fs.realpathSync(deniedRoot),
      );
      expect(driver.uploadFile).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts raw network details returned by alternate drivers before exposing them', async () => {
    const { service, driver } = makeService();
    driver.networkRequests.mockResolvedValueOnce([
      {
        url: 'http://localhost:4567/api?token=abc123&safe=value',
        method: 'GET',
        resourceType: 'xhr',
        headers: {
          Authorization: 'Bearer abc123',
          Accept: 'application/json',
        },
        timestamp: 1,
      },
    ]);

    const result = await service.networkRequests({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [
        {
          url: 'http://localhost:4567/api?token=%5BREDACTED%5D&safe=value',
          headers: {
            Authorization: '[REDACTED]',
            Accept: 'application/json',
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('abc123');
  });

  it('audits allowed driver failures as failed outcomes', async () => {
    const { service, audits } = makeService({
      navigate: async () => {
        throw new Error('driver failed');
      },
    });

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567/next',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'driver failed',
      auditId: 'audit-1',
    });
    expect(audits[0]).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
    });
  });

  it('redacts unsafe driver failure details before returning or storing audit entries', async () => {
    const { service, audits } = makeService({
      navigate: async () => {
        throw new Error(
          'failed via ws://127.0.0.1:9222/devtools/browser/id in /tmp/browser-profiles/profile-1 Authorization: Bearer abc123',
        );
      },
    });

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567/next',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    const payload = JSON.stringify({ result, audit: audits[0] });

    expect(payload).not.toContain('ws://');
    expect(payload).not.toContain('browser-profiles/profile-1');
    expect(payload).not.toContain('Bearer');
    expect(payload).not.toContain('abc123');
  });

  it('passes audit profile, instance, and limit filters through to the audit store', async () => {
    const { service, auditStore } = makeService();

    await service.getAuditLog({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      limit: 7,
    });

    expect(auditStore.list).toHaveBeenCalledWith({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      limit: 7,
    });
  });

  it('returns agent-safe profile, target, health, and audit data', async () => {
    const { service, audits } = makeService();
    audits.push({
      id: 'audit-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      action: 'snapshot',
      toolName: 'browser.snapshot',
      actionClass: 'read',
      url: 'ws://127.0.0.1:9222/devtools/browser/id',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'ws://127.0.0.1:9222/devtools/browser/id debugPort=9222',
      redactionApplied: true,
      createdAt: 1,
    });

    const [profiles, targets, health, audit] = await Promise.all([
      service.listProfiles({ instanceId: 'instance-1', provider: 'copilot' }),
      service.listTargets({ profileId: 'profile-1', instanceId: 'instance-1', provider: 'copilot' }),
      service.getHealth({ instanceId: 'instance-1', provider: 'copilot' }),
      service.getAuditLog({ instanceId: 'instance-1', provider: 'copilot' }),
    ]);
    const payload = JSON.stringify({ profiles, targets, health, audit });

    expect(payload).not.toContain('debugPort');
    expect(payload).not.toContain('debugEndpoint');
    expect(payload).not.toContain('driverTargetId');
    expect(payload).not.toContain('ws://');
  });

  it('filters listed targets by remote node id', async () => {
    const { service } = makeService({
      target: makeTarget({
        nodeId: 'node-1',
        nodeName: 'Windows PC',
      }),
    });

    const matching = await service.listTargets({
      profileId: 'profile-1',
      nodeId: 'node-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    const other = await service.listTargets({
      profileId: 'profile-1',
      nodeId: 'node-2',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(matching.data).toHaveLength(1);
    expect(matching.data?.[0]).toMatchObject({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
    });
    expect(other.data).toEqual([]);
  });

  it('executeFillPlan fills, verifies via read-back, and reports success', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant({ allowedActionClasses: ['input'] })],
    });
    // Read-back echoes the intended value so verification passes.
    driver.readControl.mockImplementation(async (_p: string, _t: string, target: string) =>
      target === '#company' ? { value: '16760348' } : { value: 'Newbury' },
    );

    const result = await service.executeFillPlan({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      steps: [
        { field: 'companyNumber', kind: 'set', target: '#company', value: '16760348' },
        { field: 'town', kind: 'set', target: '#town', value: 'Newbury' },
      ],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(result.data?.ok).toBe(true);
    expect(driver.type).toHaveBeenCalledTimes(2);
  });

  it('executeFillPlan fails loudly when a control does not reflect the intended value', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant({ allowedActionClasses: ['input'] })],
    });
    // The control keeps showing an empty value — the silent no-op case.
    driver.readControl.mockResolvedValue({ value: '' });

    const result = await service.executeFillPlan({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      steps: [{ field: 'companyNumber', kind: 'set', target: '#company', value: '16760348' }],
      maxAttempts: 1,
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'failed' });
    expect(result.data?.ok).toBe(false);
    expect(result.data?.failedAt).toBe(0);
  });

  it('executeFillPlan refuses shared existing tabs (managed profiles only)', async () => {
    const { service, driver } = makeService({
      profile: null,
      profiles: [],
      existingTab: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        title: 'Portal',
        url: 'https://portal.example.gov.uk/form',
        origin: 'https://portal.example.gov.uk',
        text: 'application form',
        allowedOrigins: [
          { scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false },
        ],
      },
    });

    const result = await service.executeFillPlan({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      steps: [{ field: 'x', kind: 'set', target: '#x', value: 'y' }],
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'execute_fill_plan_managed_profile_only',
    });
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential types a vault secret without it ever appearing in the result', async () => {
    const vault = { getSecretForFill: vi.fn(async () => 'S3cr3t-From-Vault!') };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [
        { selector: '#user', kind: 'username' },
        { selector: '#pass', kind: 'password' },
      ],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 2 } });
    // The secret was typed into the page...
    expect(driver.type).toHaveBeenCalledWith('profile-1', 'target-1', '#pass', 'S3cr3t-From-Vault!');
    // ...but never appears anywhere in the returned result (no leakage to the model).
    expect(JSON.stringify(result)).not.toContain('S3cr3t-From-Vault!');
    // Authorization was checked for the live origin.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'profile-1', origin: 'http://localhost:4567', purpose: 'login' }),
    );
  });

  it('fillCredential denies when there is no standing authorization', async () => {
    const vault = { getSecretForFill: vi.fn(async () => 'secret') };
    const authorizations = {
      check: vi.fn(() => ({ authorized: false as const, reason: 'origin_not_authorized' as const })),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(result.reason).toContain('credential_not_authorized');
    // Never resolved the secret or typed anything.
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential resolves an email_code from the mailbox and types it without leakage', async () => {
    const vault = { getSecretForFill: vi.fn(async () => 'vault-secret') };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const emailCodeReader = {
      fetchCode: vi.fn(async () => ({ code: '482913', messageId: 'm-1', matchedSender: 'noreply@localhost' })),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 1 } });
    expect(driver.type).toHaveBeenCalledWith('profile-1', 'target-1', '#otp', '482913');
    expect(JSON.stringify(result)).not.toContain('482913');
    // The email_code purpose was authorization-checked for the live origin.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'http://localhost:4567', purpose: 'email_code' }),
    );
    // Default sender allowlist is derived from the live origin host.
    expect(emailCodeReader.fetchCode).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSenderDomains: ['localhost'] }),
    );
    // The vault was never touched for a mailbox code.
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
  });

  it('fillCredential rejects email_code sender domains unrelated to the live origin', async () => {
    const vault = { getSecretForFill: vi.fn() };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const emailCodeReader = { fetchCode: vi.fn() };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
      emailCode: { senderDomains: ['some-bank.com'] },
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'email_code_sender_domain_not_allowed',
    });
    expect(emailCodeReader.fetchCode).not.toHaveBeenCalled();
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential denies email_code fields when no mailbox reader is configured', async () => {
    const vault = { getSecretForFill: vi.fn() };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
    });

    expect(result).toMatchObject({ decision: 'denied', reason: 'email_code_reader_unavailable' });
  });

  it('fillCredential reports a failed outcome when no matching code mail arrives', async () => {
    const vault = { getSecretForFill: vi.fn() };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const emailCodeReader = {
      fetchCode: vi.fn(async () => {
        throw new Error('No message from an expected sender domain arrived within the recency window');
      }),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'failed' });
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential is unavailable when the vault is not configured', async () => {
    const { service } = makeService();
    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });
    expect(result).toMatchObject({ decision: 'denied', reason: 'credential_vault_unavailable' });
  });

  it('createAgentCredential registers a vaulted account and returns only a ref + username', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(async () => ({ vaultItemRef: 'item-9', username: 'james@communitytech.co.uk' })),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const { service } = makeService({ credentialVault: vault, credentialAuthorizations: authorizations });

    const result = await service.createAgentCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      username: 'james@communitytech.co.uk',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { vaultItemRef: 'item-9', username: 'james@communitytech.co.uk' },
    });
    // The register authorization (not login) was checked.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'register', origin: 'http://localhost:4567' }),
    );
    expect(vault.createAgentCredential).toHaveBeenCalledWith({
      origin: 'http://localhost:4567',
      username: 'james@communitytech.co.uk',
    });
  });

  it('createAgentCredential denies without a register authorization', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({ authorized: false as const, reason: 'purpose_not_authorized' as const })),
    };
    const { service } = makeService({ credentialVault: vault, credentialAuthorizations: authorizations });

    const result = await service.createAgentCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      username: 'x@y.z',
    });

    expect(result).toMatchObject({ decision: 'denied' });
    expect(vault.createAgentCredential).not.toHaveBeenCalled();
  });
});
