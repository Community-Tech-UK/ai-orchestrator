import { describe, expect, it, vi } from 'vitest';
import { makeService } from './browser-gateway-service.test-helpers';
import type { BrowserLocalExtensionHealth } from './browser-local-extension-health';

/**
 * Local Mac parity: a `computer: "local"` request must get the same channel
 * honesty and fast failure the node path already has. Before this, a dead local
 * channel spent the full 90s undelivered-wait and then reported an empty target
 * list indistinguishable from "healthy, nothing shared".
 */

function channel(
  overrides: Partial<BrowserLocalExtensionHealth> = {},
): () => BrowserLocalExtensionHealth {
  return () => ({
    channelId: 'local',
    state: 'ready',
    installed: true,
    registered: true,
    polling: true,
    queue: { queuedCount: 0, inFlightCount: 0, waitingPollerCount: 1 },
    contactGaps: { gapCount: 0, longestGapMs: 0 },
    sharedTabCount: 0,
    summary: 'Local extension channel is polling (last contact 1s ago).',
    ...overrides,
  });
}

const BROKEN = channel({
  state: 'registration_broken',
  registered: false,
  polling: false,
  summary: 'Local extension native-host registration is broken; commands cannot reach Chrome.',
  remediation: 'Restart AI Orchestrator, then reload the Harness extension.',
});

describe('Browser Gateway local extension channel', () => {
  it('fails find_or_open fast with an exact repair when the local channel is provably down', async () => {
    const sendCommand = vi.fn(async () => ({}));
    const { service } = makeService({
      extensionCommandStore: { sendCommand },
      localExtensionChannel: BROKEN,
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'claude',
      computer: 'local',
      url: 'https://procontract.example/activity',
    });

    expect(result.outcome).toBe('failed');
    // The agent only ever sees `reason`, so the stable code AND the repair must
    // both live there.
    expect(result.reason).toContain('browser_local_extension_unreachable');
    expect(result.reason).toContain('registration is broken');
    expect(result.reason).toContain('Restart AI Orchestrator');
    // The point of the fast path: nothing is queued, so nothing can have run.
    expect(result.reason).toContain('did NOT run');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('still queues through the recovery wait when the local channel is merely silent', async () => {
    // A silent channel may be an MV3 service worker mid-recovery; the
    // undelivered-wait exists to ride that out, so it must not be short-circuited.
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      url: 'https://procontract.example/activity',
      title: 'Activity',
    }));
    const { service } = makeService({
      extensionCommandStore: { sendCommand },
      localExtensionChannel: channel({
        state: 'silent',
        polling: false,
        summary: 'Local extension is registered but not polling (no contact recorded).',
      }),
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'claude',
      computer: 'local',
      url: 'https://procontract.example/activity',
    });

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('succeeded');
  });

  it('reports a degraded local channel on list_targets instead of a bare empty list', async () => {
    const { service } = makeService({
      targets: [],
      localExtensionChannel: BROKEN,
    });

    const result = await service.listTargets({
      instanceId: 'instance-1',
      provider: 'claude',
      computer: 'local',
    });

    expect(result.data).toEqual([]);
    expect(result.reason).toContain('local extension channel is degraded');
    expect(result.reason).toContain('registration_broken');
  });

  it('keeps a healthy-but-empty local listing clean', async () => {
    const { service } = makeService({ targets: [], localExtensionChannel: channel() });

    const result = await service.listTargets({
      instanceId: 'instance-1',
      provider: 'claude',
      computer: 'local',
    });

    expect(result.data).toEqual([]);
    expect(result.reason).toBeUndefined();
  });

  it('stays quiet about a never-installed local extension unless local was requested', async () => {
    const notInstalled = channel({
      state: 'not_installed',
      installed: false,
      registered: false,
      polling: false,
      summary: 'No local Harness browser extension registration owned by this install.',
      remediation: 'Install the Harness Chrome extension and restart AI Orchestrator.',
    });

    const unscoped = await makeService({
      targets: [],
      localExtensionChannel: notInstalled,
    }).service.listTargets({ instanceId: 'instance-1', provider: 'claude' });
    expect(unscoped.reason).toBeUndefined();

    const scoped = await makeService({
      targets: [],
      localExtensionChannel: notInstalled,
    }).service.listTargets({ instanceId: 'instance-1', provider: 'claude', computer: 'local' });
    expect(scoped.reason).toContain('not_installed');
    expect(scoped.reason).toContain('Install the Harness Chrome extension');
  });

  it('does not apply the local precheck to a node-scoped request', async () => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      url: 'https://procontract.example/activity',
      title: 'Activity',
    }));
    const { service } = makeService({
      extensionCommandStore: { sendCommand },
      localExtensionChannel: BROKEN,
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'claude',
      nodeId: 'windows-pc',
      url: 'https://procontract.example/activity',
    });

    expect(result.reason).not.toBe('browser_local_extension_unreachable');
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});
