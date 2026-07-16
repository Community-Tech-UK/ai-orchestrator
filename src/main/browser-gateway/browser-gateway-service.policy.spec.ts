import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { BrowserCampaignService } from './browser-campaign-store';
import {
  initializeBrowserCampaignRuntime,
  stopBrowserCampaignRuntime,
} from './browser-campaign-runtime';
import {
  makeGrant,
  makeProfile,
  makeRelayNode,
  makeService,
  makeTarget,
} from './browser-gateway-service.test-helpers';
import { getWorkerNodeRegistry, WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import type { BrowserDownloadFileResult, BrowserProfile, BrowserTarget } from '@contracts/types/browser';

/**
 * `makeService()`'s default driver mocks (browser-gateway-service.test-helpers.ts)
 * infer narrow literal types for `downloadFile`/`openProfile` from their
 * default implementations. These helpers re-type those mocks to the real
 * driver contracts so per-test overrides/call assertions can use the full
 * shape without touching the shared test-helpers file.
 */
function downloadFileMock(driver: { downloadFile: unknown }): Mock<
  (...args: unknown[]) => Promise<BrowserDownloadFileResult>
> {
  return driver.downloadFile as Mock<(...args: unknown[]) => Promise<BrowserDownloadFileResult>>;
}

function openProfileMock(driver: { openProfile: unknown }): Mock<
  (profile: BrowserProfile, startUrl?: string, preferredDebugPort?: number) => Promise<BrowserTarget[]>
> {
  return driver.openProfile as Mock<
    (profile: BrowserProfile, startUrl?: string, preferredDebugPort?: number) => Promise<BrowserTarget[]>
  >;
}

describe('BrowserGatewayService policy', () => {
  afterEach(() => {
    BrowserGatewayService._resetForTesting();
    stopBrowserCampaignRuntime();
    WorkerNodeRegistry._resetForTesting();
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

  it('records managed-profile navigation against a live campaign lease', async () => {
    const campaigns = new BrowserCampaignService();
    const { service, grantStore } = makeService();
    const runtime = initializeBrowserCampaignRuntime({
      campaigns,
      grantStore,
      renewIntervalMs: 60 * 60 * 1000,
    });
    const campaign = campaigns.create({
      label: 'Overnight navigation',
      profileId: 'profile-1',
      allowedOrigins: ['http://localhost:4567'],
      allowedActionClasses: ['navigate', 'input', 'submit'],
      budget: {
        maxActions: 10,
        maxSubmits: 5,
        maxNewAccounts: 1,
        maxUploads: 1,
        maxDurationMs: 8 * 60 * 60 * 1000,
      },
    });
    const lease = runtime.claimLease({
      campaignId: campaign.id,
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    expect(lease.granted).toBe(true);

    await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567/next',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(campaigns.getCounters(campaign.id)).toMatchObject({
      actions: 1,
    });
  });

  it('records managed-profile clicks against a live campaign lease', async () => {
    const campaigns = new BrowserCampaignService();
    const { service, grantStore } = makeService();
    const runtime = initializeBrowserCampaignRuntime({
      campaigns,
      grantStore,
      renewIntervalMs: 60 * 60 * 1000,
    });
    const campaign = campaigns.create({
      label: 'Overnight clicks',
      profileId: 'profile-1',
      allowedOrigins: ['http://localhost:4567'],
      allowedActionClasses: ['navigate', 'input', 'submit'],
      budget: {
        maxActions: 1,
        maxSubmits: 5,
        maxNewAccounts: 1,
        maxUploads: 1,
        maxDurationMs: 8 * 60 * 60 * 1000,
      },
    });
    const lease = runtime.claimLease({
      campaignId: campaign.id,
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    expect(lease.granted).toBe(true);

    await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.save',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(campaigns.getCounters(campaign.id)).toMatchObject({
      actions: 1,
    });
    expect(campaigns.get(campaign.id)?.status).toBe('paused');
    expect(grantStore.revokeGrant).toHaveBeenCalledWith(
      'grant-1',
      expect.stringContaining("Budget exhausted for 'action'"),
    );
  });

  it('downloads files from managed profiles through the driver under a download grant', async () => {
    const { service, driver } = makeService({
      grants: [
        makeGrant({
          allowedActionClasses: ['file-download'],
        }),
      ],
    });
    downloadFileMock(driver).mockResolvedValue({
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
    const call = openProfileMock(driver).mock.calls[0];
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

    const call = openProfileMock(driver).mock.calls[0];
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
        getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
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
      undeliveredWaitMs: 90_000,
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
});
